(function () {
  const { UI, esc } = App;

  const LABELS = ['public', 'internal', 'confidential', 'restricted'];
  const rank = (l) => LABELS.indexOf(l);
  const enc = encodeURIComponent;
  const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
  // 1.9.0: everything engine-specific comes from GET /api/admin/connections/engines (server/src/connections/engines.ts).
  // These four are what the console falls back to when that call fails (a server from before 1.9.0).
  const PW = { usernameLabel: 'Read-only account', usernameRequired: true, secretLabel: 'Password', secretHelp: 'Sealed with the tenant key; never shown again.', multiline: false };
  const FALLBACK = [
    { id: 'postgres', title: 'PostgreSQL', family: 'sql', endpointHint: 'host:5432', database: { label: 'Database', required: false, placeholder: 'ledger', help: '' }, tlsRequired: false, dynamicCredentials: true, knowledgeSource: true, credential: PW, options: [] },
    { id: 'mysql', title: 'MySQL', family: 'sql', endpointHint: 'host:3306', database: { label: 'Database', required: false, placeholder: 'shop', help: '' }, tlsRequired: false, dynamicCredentials: true, knowledgeSource: true, credential: PW, options: [] },
    { id: 'opensearch', title: 'OpenSearch', family: 'search', endpointHint: 'https://host:9200', database: null, tlsRequired: false, dynamicCredentials: false, knowledgeSource: false, credential: Object.assign({}, PW, { usernameRequired: false }), options: [] },
    { id: 'mongodb', title: 'MongoDB', family: 'document', endpointHint: 'host:27017', database: { label: 'Database', required: true, placeholder: 'catalog', help: '' }, tlsRequired: false, dynamicCredentials: false, knowledgeSource: true, credential: PW, options: [] }
  ];
  const catalogue = () => { const s = App.stateFor('connections'); return (s.engines && s.engines.length) ? s.engines : FALLBACK; };
  const infoOf = (engine) => catalogue().find((e) => e.id === engine) || FALLBACK.find((e) => e.id === engine) || { id: engine, title: engine, family: null, endpointHint: 'host:port', database: null, tlsRequired: false, dynamicCredentials: false, knowledgeSource: false, credential: PW, options: [] };
  const titleOf = (c) => c.engineTitle || infoOf(c.engine).title;
  const familyOf = (c) => c.family || infoOf(c.engine).family;
  const isSql = (c) => familyOf(c) === 'sql';
  // 2.0.x: the left pane groups data connections by category (GET /connections/engines), then the API connections.
  const CATS = [{ id: 'relational', title: 'Relational databases' }, { id: 'nosql', title: 'NoSQL and search' }, { id: 'messaging', title: 'Messaging and cache' }, { id: 'timeseries', title: 'Time series' }];
  const engineCat = (id) => { const e = infoOf(id); if (e.category) return e.category; if (id === 'redis' || e.family === 'queue') return 'messaging'; if (e.family === 'timeseries') return 'timeseries'; if (e.family && e.family !== 'sql') return 'nosql'; return 'relational'; };
  const catOf = (c) => c.category || engineCat(c.engine);
  const catTitle = (id) => { const e = catalogue().find((x) => x.category === id && x.categoryTitle); return e ? e.categoryTitle : ((CATS.find((x) => x.id === id) || {}).title || id); };
  const restCat = (r) => r.category || (r.protocol === 'graphql' || r.protocol === 'soap' ? 'non-rest' : 'rest');
  /** The Register dialog's engine select, grouped by category in catalogue order. */
  function engineSelect(engines, value) {
    const opt = (e) => '<option value="' + esc(e.id) + '"' + (e.id === value ? ' selected' : '') + '>' + esc(e.title) + '</option>';
    const known = CATS.map((x) => x.id);
    return '<select class="select" data-engine>' + CATS.map((cat) => { const es = engines.filter((e) => engineCat(e.id) === cat.id); return es.length ? '<optgroup label="' + esc(catTitle(cat.id)) + '">' + es.map(opt).join('') + '</optgroup>' : ''; }).join('')
      + engines.filter((e) => known.indexOf(engineCat(e.id)) < 0).map(opt).join('') + '</select>';
  }
  // 1.9.99-final (B-10304): the MongoDB-compatible services read the same query model.
  const isMongo = (c) => ['mongodb', 'documentdb', 'cosmos-mongodb', 'do-mongodb'].indexOf(c.engine) >= 0;
  const isTsql = (c) => c.engine === 'mssql' || c.engine === 'azure-sql';
  /** Engines whose examples carry a LIMIT clause; the others get the server's row cap alone. */
  const hasLimit = (c) => ['postgres', 'mysql', 'snowflake', 'bigquery'].indexOf(c.engine) >= 0;
  const firstRows = (c, obj, n) => (hasLimit(c) ? 'SELECT *\nFROM ' + obj + '\nLIMIT ' + n + ';' : c.engine === 'oracle' ? 'SELECT *\nFROM ' + obj : 'SELECT *\nFROM ' + obj + ';');
  const term = (c) => (c.engine === 'oracle' ? '' : ';');
  const queryHint = (c) => {
    if (infoOf(c.engine).queryHint) return infoOf(c.engine).queryHint;
    if (isTsql(c)) return 'T-SQL, one statement';
    if (c.engine === 'oracle') return 'Oracle SQL, one statement, no PL/SQL';
    if (c.engine === 'snowflake') return 'Snowflake SQL, one statement';
    if (c.engine === 'bigquery') return 'GoogleSQL (standard SQL), one statement; name tables dataset.table';
    if (c.engine === 'mysql') return 'MySQL SQL, one statement';
    if (isSql(c)) return 'SQL, one statement';
    if (isMongo(c)) return 'JSON: find with filter, projection, sort and limit, or aggregate with a pipeline';
    return 'POST /index/_search or _count, then a JSON body';
  };
  /** Engines whose examples come from the catalogue (key-value, queue and time-series), with the write each refuses. */
  const fromCatalogue = (c) => ['keyvalue', 'queue', 'timeseries'].indexOf(familyOf(c)) >= 0 || (!isSql(c) && !isMongo(c) && !!(infoOf(c.engine).examples || []).length);
  const WRITE_EXAMPLE = { redis: { label: 'DEL (write)', q: 'DEL {object}' }, rabbitmq: { label: 'purge (write)', q: 'purge {object}' }, influxdb: { label: 'DROP MEASUREMENT (DDL)', q: 'DROP MEASUREMENT "{object}"' }, dynamodb: { label: 'UPDATE (write)', q: 'UPDATE "{object}" SET reviewed = true WHERE pk = \'x\'' }, 'cosmos-nosql': { label: 'DELETE (write)', q: 'DELETE FROM c' } };
  const readOnlyNote = (c) => {
    if (c.engine === 'redis') return 'Only read commands for allow-listed key patterns are sent, one connection per read. Use an ACL user with +@read -@write: Test connection reports a user that can write.';
    if (c.engine === 'rabbitmq') return 'Only management API reads are sent; peeking at messages is off unless the connection turns it on. Use a user without write or configure permissions.';
    if (c.engine === 'dynamodb') return 'Only Query and PartiQL SELECT naming the partition key are sent; writes and scans are refused before anything reaches DynamoDB. Use an IAM key allowed Query, PartiQLSelect, DescribeTable and ListTables only.';
    if (c.engine === 'cosmos-nosql') return 'Only one SQL SELECT per read is sent through the query API. Use a read-only key, or a principal with the Data Reader role.';
    if (familyOf(c) === 'timeseries') return 'Only queries are sent (Prometheus\'s query API, InfluxQL SELECT and SHOW, or SQL on InfluxDB 3); Flux and the admin APIs are never used. Use a read-only token or user.';
    if (isMongo(c)) return 'Only find and aggregate with allow-listed stages are sent, with no server-side JavaScript. Use an account with the read role: Test connection reports any write privilege.';
    if (isTsql(c)) return 'Read-only is enforced by the database account, and every read runs in a transaction that is rolled back. The query parser is advisory.';
    // 1.9.99-final, Sprint 61 (B-10907): D1 has no read-only role, so the parser is not advisory there.
    if (c.engine === 'cloudflare-d1') return 'D1 has no read-only role: the query parser refuses every write, PRAGMA and schema change before anything is sent to Cloudflare. Scope the API token to D1 on this account.';
    if (c.engine === 'snowflake' || c.engine === 'bigquery') return 'Read-only is enforced by the account\'s role. The query parser refuses writes and DDL before anything is sent over HTTPS.';
    return 'Read-only is enforced by the database account and a read-only transaction. The query parser is advisory.';
  };
  /** 2.0.x: the read-only note, and where schema changes run when the connection has an admin account. */
  const accessNote = (c) => readOnlyNote(c) + (c.admin && c.admin.set ? ' Schema changes run on ' + (c.admin.account || 'the admin account') + ' after a preview; every change is audited.' : '');

  /** An engine's own settings as form fields; `when` fields carry what decides whether they show. */
  function optionFields(info, values) {
    return (info.options || []).map((o) => {
      const v = values && values[o.name] != null ? String(values[o.name]) : '';
      const attrs = 'data-opt="' + esc(o.name) + '" data-opttype="' + esc(o.type) + '"';
      const ctl = o.type === 'select'
        ? UI.select(o.choices || [], v || ((o.choices || [])[0] || {}).value, attrs)
        : UI.input(v, { type: o.type === 'number' ? 'number' : 'text', placeholder: o.placeholder || '', attrs: attrs + ' autocomplete="off" spellcheck="false"' });
      return '<div data-optwrap="' + esc(o.name) + '"' + (o.when ? ' data-when-opt="' + esc(o.when.option) + '" data-when-val="' + esc(o.when.value) + '"' : '') + '>' + UI.field(o.label, ctl, esc(o.help || '')) + '</div>';
    }).join('');
  }
  /** Shows each `when` field only while the option it depends on has its value. */
  function applyWhen(scope) {
    scope.querySelectorAll('[data-when-opt]').forEach((w) => {
      const dep = scope.querySelector('[data-opt="' + w.dataset.whenOpt + '"]');
      w.hidden = !dep || dep.value !== w.dataset.whenVal;
    });
  }
  /** The option values in `scope`: numbers as numbers, empty and hidden fields left out. */
  function readOptions(scope) {
    const out = {};
    scope.querySelectorAll('[data-opt]').forEach((i) => {
      const wrap = i.closest('[data-optwrap]');
      if (wrap && wrap.hidden) return;
      const v = (i.value || '').trim();
      if (!v) return;
      out[i.dataset.opt] = i.dataset.opttype === 'number' ? Number(v) : v;
    });
    return out;
  }
  /** The secret input: a textarea for keys (PEM, JSON), a password field otherwise. */
  const secretInput = (cred) => (cred.multiline
    ? '<textarea class="textarea mono" data-pass rows="5" autocomplete="off" spellcheck="false" autocapitalize="off" style="min-height:96px"></textarea>'
    : '<input type="password" class="input" data-pass autocomplete="new-password">');
  const mongoFind = (coll, limit) => '{\n  "find": ' + JSON.stringify(coll) + ',\n  "filter": {},\n  "limit": ' + limit + '\n}';
  const ZONES = ['data', 'app', 'sandbox', 'inference', 'directory', 'training', 'edge'];
  const HEALTH = { healthy: 'ok', degraded: 'warn', unreachable: 'danger', unknown: '' };
  const cell = (v) => (v == null ? '<span class="muted">null</span>' : esc(typeof v === 'object' ? JSON.stringify(v) : String(v)));

  /** Example queries built from the connection's own schema: a read, and the refusals the board shows. */
  function examples(c) {
    const allowed = c.schema.filter((o) => o.allowed);
    const outside = c.schema.filter((o) => !o.allowed);
    const obj = allowed[0] ? allowed[0].name : null;
    if (isSql(c)) {
      const col = obj && allowed[0].columns[0] ? allowed[0].columns[0].name : 'id';
      return [
        obj ? { id: 'read', label: 'First rows of ' + obj, q: firstRows(c, obj, c.rowLimit) } : null,
        obj ? { id: 'update', label: 'UPDATE (write)', q: 'UPDATE ' + obj + '\nSET ' + col + ' = ' + col + term(c) } : null,
        obj ? { id: 'ddl', label: 'DROP TABLE (DDL)', q: 'DROP TABLE ' + obj + term(c) } : null,
        outside[0] ? { id: 'denied', label: 'Table outside the allow-list', q: firstRows(c, outside[0].name, 10).replace(/\n/g, ' ') } : null
      ].filter(Boolean);
    }
    if (isMongo(c)) {
      return [
        obj ? { id: 'read', label: 'First documents of ' + obj, q: mongoFind(obj, c.rowLimit) } : null,
        obj ? { id: 'update', label: 'updateMany (write)', q: 'db.' + obj + '.updateMany({}, { "$set": { "reviewed": true } })' } : null,
        obj ? { id: 'ddl', label: 'drop (DDL)', q: '{ "drop": ' + JSON.stringify(obj) + ' }' } : null,
        outside[0] ? { id: 'denied', label: 'Collection outside the allow-list', q: mongoFind(outside[0].name, 10) } : null
      ].filter(Boolean);
    }
    if (fromCatalogue(c)) {
      const fill = (q, o) => q.split('{object}').join(o);
      const exs = (infoOf(c.engine).examples || []).map((x, i) => (obj ? { id: 'ex' + i, label: x.label + ' of ' + obj, q: fill(x.query, obj) } : null));
      const w = WRITE_EXAMPLE[c.engine];
      if (obj && w) exs.push({ id: 'write', label: w.label, q: fill(w.q, obj) });
      const first = (infoOf(c.engine).examples || [])[0];
      if (outside[0] && first) exs.push({ id: 'denied', label: (infoOf(c.engine).objectNoun || 'Object') + ' outside the allow-list', q: fill(first.query, outside[0].name) });
      return exs.filter(Boolean);
    }
    const pat = obj || 'logs-*';
    return [
      { id: 'read', label: 'Latest documents', q: 'POST /' + pat + '/_search\n{\n  "size": ' + c.rowLimit + ',\n  "query": { "match_all": {} }\n}' },
      { id: 'delete', label: 'delete_by_query (write)', q: 'POST /' + pat + '/_delete_by_query\n{ "query": { "match_all": {} } }' },
      { id: 'ddl', label: 'Delete index (DDL)', q: 'DELETE /' + pat.replace(/\*$/, '2026.01.01') },
      outside[0] ? { id: 'denied', label: 'Index outside the allow-list', q: 'POST /' + outside[0].name + '/_search\n{ "size": 10 }' } : null
    ].filter(Boolean);
  }

  function cur(st) { return (st.conns || []).find((c) => c.id === st.conn) || null; }

  App.register({
    id: 'connections', title: 'Connections', live: true, summary: 'Data and API connections by category, schema allow-lists, schema designer, queues, sync status, data browser', section: 'admin',
    crumb: (st) => ['Admin', 'Connections'].concat(cur(st) ? [cur(st).name] : []),
    label: (st) => (cur(st) ? cur(st).label : null),
    commands: [
      { label: 'Register a connection', sub: 'Connections', run(app) { app.stateFor('connections').register = true; app.render(); } },
      { label: 'Open the data browser', sub: 'Connections', run(app) { const s = app.stateFor('connections'); s.tab = 'browser'; app.render(); } }
    ],
    states: [
      { title: 'Parser could not read it', tone: 'warn', text: 'The query uses vendor syntax the parser does not know. The user sees the query and confirms before it runs on the read-only account.', apply(ctx) { ctx.state.demo = 'unparsed'; ctx.rerender(); } },
      { title: 'Write refused', tone: 'danger', text: 'An UPDATE was proposed on a read-only connection. The database would refuse it, so it is not sent.', apply(ctx) { ctx.state.demo = 'write'; ctx.rerender(); } },
      { title: 'Row cap reached', tone: 'neutral', text: 'The row limit of rows returned out of a larger estimate, with a prompt to aggregate instead.', apply(ctx) { ctx.state.demo = 'capped'; ctx.rerender(); } },
      { title: 'Database engines', tone: 'info', text: 'Register offers PostgreSQL, MySQL, SQL Server, Azure SQL, Oracle, Snowflake, BigQuery, OpenSearch and MongoDB, with a sealed account (a private key or a service account key for Snowflake and BigQuery), or OpenBao dynamic credentials for PostgreSQL and MySQL.', apply(ctx) { ctx.state.register = true; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      const toast = (html, kind, ms) => ctx.toast('<span>' + html + '</span>', kind, ms);
      if (!st.loaded && !st.loading) st.paramHash = null;
      // The shell re-reads the hash on every render, so a link's parameters apply once per visit.
      if ((ctx.params.conn || ctx.params.tab) && st.paramHash !== location.hash) { if (ctx.params.conn) st.conn = ctx.params.conn; if (ctx.params.tab) st.tab = ctx.params.tab; st.paramHash = location.hash; }
      st.tab = st.tab || 'browser'; st.allow = st.allow || {}; st.sqlBy = st.sqlBy || {}; st.results = st.results || {};
      const later = () => { if (App.state.route !== 'connections') return; if (document.querySelector('.overlay')) { setTimeout(later, 250); return; } ctx.rerender(); };
      const load = () => {
        if (st.loading) return;
        st.loading = true;
        // 1.8.0 (B-126): REST connections are listed beside the data connections.
        // 1.9.0: the engine catalogue, once; a server without it leaves the four built-in engines.
        Promise.all([App.get('/api/admin/connections'), App.get('/api/admin/rest-connections').catch(() => []), st.engines ? Promise.resolve(st.engines) : App.get('/api/admin/connections/engines').catch(() => null)]).then(([c, rc, eng]) => { st.conns = c; st.rest = rc; if (Array.isArray(eng) && eng.length) st.engines = eng; st.restLoaded = true; st.loaded = true; st.loadError = null; }).catch((err) => { st.loadError = err; }).finally(() => { st.loading = false; later(); });
      };
      if ((!st.loaded && !st.loadError) || (st.loaded && st.restLoaded === false)) load();
      const act = async (fn, okMsg) => { try { const r = await fn(); if (okMsg) toast(okMsg, 'ok', 5000); load(); return r || true; } catch (err) { App.fail(err); return null; } };

      if (st.register) { st.register = false; setTimeout(() => openRegister(), 30); }
      if (st.loadError || !st.loaded) {
        root.innerHTML = '<div class="page">' + UI.pagehead('Connections', 'Data and API connections', UI.btn('Register', { attrs: 'data-register' }))
          + (st.loadError ? UI.problem('Connections could not be loaded', st.loadError.message, st.loadError.problem && st.loadError.problem.trace_id) + '<div>' + UI.btn('Try again', { attrs: 'data-reload' }) + '</div>' : UI.notice('Loading…', 'info')) + '</div>';
        ctx.on('click', '[data-reload]', () => { st.loadError = null; ctx.rerender(); });
        ctx.on('click', '[data-register]', () => openRegister());
        return;
      }

      const conns = st.conns;
      if (!conns.find((c) => c.id === st.conn)) st.conn = conns[0] ? conns[0].id : null;
      const restConn = st.restSel ? (st.rest || []).find((x) => x.id === st.restSel) || null : null;
      const conn = restConn ? null : cur(st);
      const myClearance = (App.me && App.me.user && App.me.user.clearance) || 'internal';
      const canKb = App.can('knowledge:manage');

      // ---- demo states: stage the query on a real connection and send it, so the server's answer is what shows ----
      if (st.demo) {
        const d = st.demo; st.demo = null; st.demoNote = null;
        const pg = conns.find((c) => c.engine === 'postgres' && c.schema.some((o) => o.allowed) && rank(c.label) <= rank(myClearance));
        if (!pg) st.demoNote = 'This state needs a PostgreSQL connection with an allow-listed table at or below your clearance. Register one, refresh its schema and allow a table.';
        else {
          const obj = pg.schema.find((o) => o.allowed); const col = obj.columns[0] ? obj.columns[0].name : 'id';
          st.conn = pg.id; st.tab = 'browser'; st.editing = false;
          st.sqlBy[pg.id] = d === 'unparsed' ? 'SELECT ' + col + ', ' + col + '::vendor_money AS amount\nFROM ' + obj.name + '\nLIMIT 50;' : d === 'write' ? 'UPDATE ' + obj.name + '\nSET ' + col + ' = ' + col + ';' : 'SELECT *\nFROM ' + obj.name + '\nORDER BY 1;';
          st.runNow = true;
        }
        return ctx.rerender();
      }

      const above = conn && rank(conn.label) > rank(myClearance);
      if (conn && st.sqlBy[conn.id] == null) { const ex = examples(conn)[0]; st.sqlBy[conn.id] = ex ? ex.q : ''; }
      const sql = conn ? st.sqlBy[conn.id] : '';
      const r = conn ? st.results[conn.id] : null;
      const exs = conn ? examples(conn) : [];
      const allowedObjs = conn ? conn.schema.filter((o) => o.allowed) : [];
      const outsideObjs = conn ? conn.schema.filter((o) => !o.allowed) : [];

      const schemaTree = () => '<div class="panel" style="gap:4px"><div class="phead"><div class="eyebrow">Allowed schema</div>' + UI.btn('Allow-list', { kind: 'ghost', size: 'xs', attrs: 'data-tab="allow"' }) + '</div>'
        + (conn.schemaAt ? '' : '<div class="muted" style="font-size:12px">Not introspected yet. Refresh schema to read the objects the account can see.</div>')
        + allowedObjs.map((t) => '<div class="conn-tree"><button type="button" class="conn-obj' + (st.treeOpen === t.name ? ' on' : '') + '" data-obj="' + esc(t.name) + '">' + UI.icon('chevd', 12) + '<span class="mono">' + esc(t.name) + '</span></button>' + t.columns.map((c) => '<div class="conn-col"><span class="mono">' + esc(c.name) + ' <span class="muted">' + esc(c.type) + '</span></span>' + (c.pii ? UI.pill('PII, masked', 'warn') : '') + '</div>').join('') + '</div>').join('')
        + (conn.schemaAt && !allowedObjs.length ? '<div class="muted" style="font-size:12px">Nothing is allow-listed yet.</div>' : '')
        + (outsideObjs.length ? '<div class="muted" style="font-size:12px;margin-top:6px">Not on the allow-list: ' + outsideObjs.slice(0, 12).map((d) => '<span class="mono">' + esc(d.name) + '</span>').join(', ') + (outsideObjs.length > 12 ? ' and ' + (outsideObjs.length - 12) + ' more' : '') + '</div>' : '') + '</div>';

      const auditLink = '<div class="muted" style="font-size:12px">Refusals are written to the audit log with the query text and the actor.' + (App.canOpen('usage-audit') ? ' <a href="#" data-audit>Open in Usage and audit</a>' : '') + '</div>';
      let resultHtml = '';
      // With no connection registered there is nothing to show (and no conn to read limits from).
      if (!conn) resultHtml = '';
      else if (above) resultHtml = UI.notice('This connection is labelled <b>' + esc(conn.label) + '</b> and your clearance is ' + esc(myClearance) + '. The schema is listed; queries and results are withheld.', 'warn');
      else if (st.running) resultHtml = UI.notice('Running on the read-only account…', 'info');
      else if (!r) resultHtml = '<div class="muted" style="font-size:12px">Run the query to see results. Row limit ' + conn.rowLimit + ', timeout ' + conn.timeoutS + ' s, results labelled ' + esc(conn.label) + '.</div>';
      else if (r.ok) {
        const o = r.ok;
        resultHtml = (o.capped ? UI.notice('<b>Row cap reached.</b> ' + o.rows.length + ' of ' + (o.estimate ? 'an estimated ' + Number(o.estimate).toLocaleString() : 'more') + ' rows returned. Aggregate instead so the model sees the whole picture.', 'info', isSql(conn) ? UI.btn('Aggregate instead', { size: 'sm', attrs: 'data-aggregate' }) : '') : '')
          + (o.unparsed ? UI.notice('Ran as written on the read-only account after confirmation. Logged as an unparsed query in the audit chain.', 'info') : '')
          + UI.table(o.columns, o.rows.map((row) => row.map(cell)), { clickable: false, minWidth: '0', emptyTitle: 'No rows', emptyText: 'The query ran and returned nothing.' })
          + '<span class="muted" style="font-size:12px">' + o.rows.length + ' row' + (o.rows.length === 1 ? '' : 's') + (o.capped ? ' (capped)' : '') + ', ' + o.ms + ' ms, labelled ' + esc(o.label) + '.' + (o.masked.length ? ' Masked: ' + o.masked.map(esc).join(', ') + '.' : '') + '</span>';
      } else if (r.error) {
        const p = r.error.problem || {};
        if (p.kind === 'unparsed' && r.error.status === 409) resultHtml = UI.notice('<b>Parser could not read it.</b> ' + esc(r.error.message), 'warn', UI.btn('Run on the read-only account', { size: 'sm', attrs: 'data-runanyway' }) + UI.btn('Edit', { kind: 'ghost', size: 'sm', attrs: 'data-editsql' }));
        else resultHtml = UI.problem(p.title || 'Refused', r.error.message, p.trace_id) + (r.error.status === 422 || r.error.status === 403 ? auditLink : '');
      }

      const browser = () => (above
        ? '<div class="cols"><div style="width:270px;flex-shrink:0">' + schemaTree() + '</div><div class="vstack grow">' + resultHtml + '</div></div>'
        : '<div class="cols"><div style="width:270px;flex-shrink:0">' + schemaTree() + '</div>'
        + '<div class="vstack grow" style="gap:10px"><div class="hstack wrap"><div class="eyebrow">Query</div><span class="muted" style="font-size:12px">' + esc(queryHint(conn)) + '</span><span class="right hstack gap6 wrap">' + exs.map((x) => UI.chip(esc(x.label), x.q === sql, 'data-example="' + x.id + '"')).join('') + '</span></div>'
        + (st.editing ? '<textarea class="textarea mono" data-sqledit style="min-height:126px;white-space:pre">' + esc(sql) + '</textarea>' : '<div data-code style="cursor:text" title="Click to edit">' + UI.code(sql || (isSql(conn) ? '-- write a query' : isMongo(conn) ? '{ "find": "collection" }' : '# write a request'), isSql(conn) ? 'sql' : 'json') + '</div>')
        + '<div class="hstack wrap">' + UI.btn('Run query', { kind: 'primary', icon: 'play', attrs: 'data-run', disabled: !!st.running }) + UI.btn('Export', { icon: 'download', attrs: 'data-export' + (r && r.ok ? '' : ' disabled') }) + (st.editing ? UI.btn('Done editing', { kind: 'ghost', attrs: 'data-doneedit' }) : UI.btn('Edit', { kind: 'ghost', attrs: 'data-editsql' })) + '<span class="muted" style="font-size:12px">Row limit ' + conn.rowLimit + ', timeout ' + conn.timeoutS + ' s, results labelled ' + esc(conn.label) + '</span></div>'
        + resultHtml + '</div></div>');

      const info = conn ? infoOf(conn.engine) : null;
      const canDesign = !!conn && App.can('connections:manage') && App.connectionDesigner.designKinds(conn).length > 0;
      const hasQueues = !!conn && App.connectionDesigner.hasQueues(conn);
      if (conn && ((st.tab === 'designer' && !canDesign) || (st.tab === 'queues' && !hasQueues))) st.tab = 'browser';
      const D = App.connectionDesigner;
      st.adminView = conn && st.tab === 'settings' ? D.adminCredentialField(ctx, conn, info, load) : null;
      const settings = () => '<div class="panel"><div class="formgrid" style="--cols:3">'
        + UI.field('Type', UI.select([{ value: conn.engine, label: titleOf(conn) }], conn.engine, 'disabled'), 'Fixed after registration')
        + UI.field('Endpoint', UI.input(conn.endpoint, { placeholder: info.endpointHint || '', attrs: 'data-setting="endpoint"' }))
        + (info.database ? UI.field(info.database.label, UI.input(conn.database || '', { placeholder: info.database.placeholder || '', attrs: 'data-setting="database"' }), esc(info.database.help || '')) : '')
        + UI.field('Network zone', UI.select(['data', 'core', 'gpu', 'edge'].concat(['data', 'core', 'gpu', 'edge'].indexOf(conn.zone) < 0 ? [conn.zone] : []), conn.zone, 'data-setting="zone"'))
        + (conn.credentialSource === 'openbao'
          ? UI.field('Credential', UI.input('OpenBao role ' + (conn.baoRole || '') + (conn.lease ? ', account ' + conn.lease.username + ' until ' + when(conn.lease.expiresAt) : ''), { readonly: true, attrs: 'class="input mono"' }), 'Short-lived accounts from the OpenBao database engine, renewed while in use and revoked when dropped. Switch to a sealed account with Rotate credential.')
          : UI.field('Credential', UI.input(conn.hasCredential ? (conn.account || 'set') + ' (sealed)' : 'none', { readonly: true, attrs: 'class="input mono"' }), 'Sealed with the tenant key and never shown again. Replace it with Rotate credential.'))
        + UI.field('Label ceiling', UI.select(LABELS, conn.label, 'data-setting="label"'), 'Results carry this label. Conversations above it cannot use the connection.')
        + (st.adminView ? st.adminView.html : '')
        + UI.field('Row limit', UI.input(String(conn.rowLimit), { type: 'number', attrs: 'data-setting="rowLimit"' }))
        + UI.field('Statement timeout, s', UI.input(String(conn.timeoutS), { type: 'number', attrs: 'data-setting="timeoutS"' }))
        + UI.field('TLS', UI.toggle('Verify the server certificate', conn.tls || info.tlsRequired, 'data-setting-tls' + (info.tlsRequired ? ' disabled aria-disabled="true"' : '')), info.tlsRequired ? esc(titleOf(conn)) + ' connections always use TLS.' : '')
        + UI.field('PII masking', UI.toggle('Mask PII-classified columns in every result', true, 'data-manual data-mask'))
        + '</div>' + ((info.options || []).length ? '<div class="eyebrow">' + esc(titleOf(conn)) + ' settings</div><div class="formgrid" style="--cols:3" data-optsform>' + optionFields(info, conn.options || {}) + '</div>' : '')
        + '<div class="hstack">' + UI.btn('Save settings', { kind: 'primary', attrs: 'data-save' }) + UI.btn('Rotate credential now', { attrs: 'data-rotate' }) + UI.btn('Remove connection', { kind: 'danger', attrs: 'data-remove' }) + '<span class="muted right" style="font-size:12px">Version ' + conn.version + '</span></div></div>';

      const allow = () => {
        const on = (name, def) => (st.allow[conn.id + '|' + name] != null ? st.allow[conn.id + '|' + name] : def);
        const extra = conn.allowList.filter((a) => !conn.schema.some((o) => o.name === a));
        const rows = conn.schema.map((t) => ({ name: t.name, shape: t.columns.length + ' columns' + (t.kind ? ', ' + t.kind : ''), pii: t.columns.some((c) => c.pii), def: t.allowed })).concat(extra.map((a) => ({ name: a, shape: isSql(conn) ? 'not introspected' : isMongo(conn) ? 'collection pattern' : 'index pattern', pii: false, def: true, pattern: true })));
        return '<div class="vstack" style="gap:10px">' + UI.notice('Only allow-listed objects appear in the introspected schema the model sees. Everything else is refused before the query is sent.', 'info')
          + UI.table(['', 'Object', 'Shape', 'Classification', 'Queries'], rows.map((t) => { const v = on(t.name, t.def); return { cells: [UI.check('', v, 'data-allowobj="' + esc(t.name) + '"'), '<span class="mono">' + esc(t.name) + '</span>', esc(t.shape), t.pii ? UI.pill('PII masked', 'warn') : t.pattern ? UI.pill('pattern') : UI.pill('clean', 'ok'), v ? UI.pill('allowed', 'ok') : UI.pill('refused', 'danger')] }; }), { clickable: false, minWidth: '0', emptyTitle: 'No schema yet', emptyText: 'Refresh schema to introspect the objects the account can read.' })
          + (conn.engine === 'opensearch' ? UI.field('Add an index pattern', UI.input('', { placeholder: 'logs-*', attrs: 'data-newpattern' })) : '')
          + (isMongo(conn) ? UI.field('Add a collection pattern', UI.input('', { placeholder: 'orders_*', attrs: 'data-newpattern' }), 'Collection names are case-sensitive; * matches any characters.') : '')
          + UI.field('Extra PII columns', UI.input(conn.piiColumns.join(', '), { placeholder: 'schema.table.column, …', attrs: 'data-pii' }), 'Columns named like emails, IBANs, phones or national identifiers are masked already; list any others here.')
          + '<div class="hstack">' + UI.btn('Save allow-list', { kind: 'primary', attrs: 'data-saveallow' }) + '<span class="muted" style="font-size:12px">' + (conn.schemaAt ? 'Schema introspected ' + esc(when(conn.schemaAt)) + '. Refresh schema after a migration.' : 'Schema not introspected yet.') + '</span></div></div>';
      };

      const sync = () => '<div class="vstack" style="gap:10px">' + UI.table(['Target', 'Source object', 'Mode', 'Last sync', 'Volume', 'Status'], conn.syncs.map((s) => ['<a href="#" data-gokb="' + esc(s.kbId) + '">' + esc(s.kb) + '</a>', '<span class="mono">' + esc(s.object) + '</span>', 'Watermark, incremental', esc(when(s.lastSyncAt) || 'not yet'), s.docs + ' document' + (s.docs === 1 ? '' : 's'), UI.pill(s.state === 'idle' ? (s.lastSyncAt ? 'synced' : 'queued') : s.state)]), { clickable: false, minWidth: '0', emptyTitle: 'Nothing syncs from this connection', emptyText: 'Use as knowledge source to add a table or view to a knowledge base.' })
        + '<div class="hstack">' + UI.btn('Sync now', { attrs: 'data-syncnow' + (conn.syncs.length ? '' : ' disabled') }) + '<span class="muted" style="font-size:12px">Each row becomes a document; the chunks carry the connection\'s label, so retrieval respects it.</span></div></div>';

      // ---- left pane: data connections by category, then REST and non-REST APIs; each group collapses ----
      st.groupsShut = st.groupsShut || {};
      const groupHead = (id, title, count, actions) => { const open = !st.groupsShut[id]; return '<div class="conn-ghead"><button type="button" class="conn-gbtn" data-cgroup="' + id + '" aria-expanded="' + open + '" aria-controls="conn-g-' + id + '">' + UI.icon(open ? 'chevd' : 'chev', 12) + '<span class="grow">' + esc(title) + '</span><span class="conn-gcount">' + count + '</span></button>' + (actions || '') + '</div>'; };
      const groupBody = (id, html) => '<div class="conn-gbody" id="conn-g-' + id + '"' + (st.groupsShut[id] ? ' hidden' : '') + '>' + html + '</div>';
      const dataItem = (c) => UI.listItem(esc(c.name), esc(titleOf(c)) + (c.zone ? ', zone ' + esc(c.zone) : ''), { active: conn && c.id === conn.id, attrs: 'data-conn="' + esc(c.id) + '"', right: UI.label(c.label, { sm: true }) });
      const knownCats = CATS.map((x) => x.id);
      const extraCats = []; conns.forEach((c) => { const k = catOf(c); if (knownCats.indexOf(k) < 0 && extraCats.indexOf(k) < 0) extraCats.push(k); });
      const dataGroups = knownCats.concat(extraCats).map((k) => { const list = conns.filter((c) => catOf(c) === k); return list.length ? '<div class="conn-group">' + groupHead(k, catTitle(k), list.length) + groupBody(k, list.map(dataItem).join('')) + '</div>' : ''; }).join('');
      const restItem = (c) => UI.listItem(esc(c.name), ({ rest: 'REST', graphql: 'GraphQL', soap: 'SOAP', odata: 'OData' }[c.protocol] || 'REST') + ', ' + esc(c.host || '') + ', ' + (c.endpoints || []).length + ' endpoint' + ((c.endpoints || []).length === 1 ? '' : 's'), { active: restConn && c.id === restConn.id, attrs: 'data-restconn="' + esc(c.id) + '"', right: UI.label(c.label, { sm: true }) });
      const restList = (st.rest || []).filter((c) => restCat(c) === 'rest'); const otherList = (st.rest || []).filter((c) => restCat(c) !== 'rest');
      const apiGroups = '<div class="conn-group">' + groupHead('rest', 'REST APIs', restList.length, UI.btn('Register REST', { size: 'xs', attrs: 'data-registerrest' })) + groupBody('rest', restList.map(restItem).join('') + (restList.length ? '' : '<div class="muted" style="font-size:12px">No REST or OData APIs yet.</div>')) + '</div>'
        + '<div class="conn-group">' + groupHead('non-rest', 'Non-REST APIs', otherList.length, UI.btn('Register GraphQL or SOAP', { size: 'xs', attrs: 'data-registerapi="graphql"' })) + groupBody('non-rest', otherList.map(restItem).join('') + (otherList.length ? '' : '<div class="muted" style="font-size:12px">No GraphQL or SOAP APIs yet.</div>')) + '</div>';

      root.innerHTML = '<style>'
        + '#main > .page > *{flex-shrink:0}'
        + '#main .conn-left{width:300px}'
        + '#main .conn-tree{display:flex;flex-direction:column;gap:2px;margin-bottom:6px}'
        + '#main .conn-obj{display:flex;align-items:center;gap:4px;border:0;background:transparent;padding:4px 4px;border-radius:4px;cursor:pointer;font-weight:500;color:var(--fg);text-align:left;font-family:inherit}#main .conn-obj:hover{background:var(--sel)}'
        + '#main .conn-col{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:2px 4px 2px 22px;color:var(--fg2)}'
        + '#main .conn-list,#main .conn-rest-list,#main .conn-gbody{display:flex;flex-direction:column;gap:2px}'
        + '#main .conn-gbody[hidden]{display:none}'
        + '#main .conn-group{display:flex;flex-direction:column;gap:2px;margin-top:6px}'
        + '#main .conn-ghead{display:flex;align-items:center;gap:6px;flex-wrap:wrap}'
        + '#main .conn-gbtn{display:flex;align-items:center;gap:6px;flex:1 1 140px;min-width:0;border:0;background:transparent;padding:4px;border-radius:4px;cursor:pointer;color:var(--fg2);font:inherit;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;text-align:left}'
        + '#main .conn-gbtn:hover{background:var(--sel);color:var(--fg)}'
        + '#main .conn-gcount{color:var(--muted);font-weight:500}'
        + '</style>'
        + '<div class="leftpane conn-left"><div class="hstack"><div class="eyebrow grow">Connections</div>' + UI.btn('Register', { size: 'sm', attrs: 'data-register' }) + '</div>'
        + '<div class="conn-list">' + dataGroups + (conns.length ? '' : '<div class="muted" style="font-size:12px">No data connections yet.</div>') + '</div>'
        + '<div class="conn-rest-list">' + apiGroups + '</div>'
        + '<div class="divider"></div><div class="muted" style="font-size:12px">Queries only read. Schema changes run on a separate admin account, after a preview.</div></div>'
        + '<div class="page">'
        + (st.demoNote ? UI.notice(esc(st.demoNote), 'info', UI.btn('Dismiss', { kind: 'ghost', size: 'sm', attrs: 'data-dismissnote' })) : '')
        + (restConn ? (st.restView = App.connectionSources.restPage(ctx, restConn, st, () => ctx.rerender())).html : !conn ? UI.pagehead('Connections', 'Data and API connections for the data browser, knowledge sources and the schema designer', '') + UI.empty('No connections yet', 'Register a database, warehouse, search cluster, cache or queue (' + catalogue().map((e) => e.title).join(', ') + ') with a read-only account, then introspect its schema and allow the objects the model may read. Schema changes need a separate admin account and run only after a preview.', UI.btn('Register a connection', { kind: 'primary', attrs: 'data-register' }))
          : UI.pagehead(esc(conn.name), esc(conn.endpoint) + (conn.database ? '/' + esc(conn.database) : '') + (conn.credentialSource === 'openbao' ? ', OpenBao role ' + esc(conn.baoRole || '') : ', account ' + esc(conn.account || 'not set')) + ' ' + UI.pill(conn.health, HEALTH[conn.health]), UI.btn('Test connection', { attrs: 'data-test' }) + UI.btn('Refresh schema', { icon: 'refresh', attrs: 'data-refresh' }) + (canKb && info.knowledgeSource ? UI.btn('Use as knowledge source', { kind: 'primary', attrs: 'data-usekb' }) : ''))
          + (conn.health === 'degraded' || conn.health === 'unreachable' ? UI.notice(esc(conn.healthDetail || (conn.health === 'unreachable' ? 'The last test could not reach the server.' : 'The last test reported a problem.')) + (conn.checkedAt ? ' <span class="muted">Checked ' + esc(when(conn.checkedAt)) + '.</span>' : ''), conn.health === 'unreachable' ? 'danger' : 'warn', App.canOpen('zones') ? '<a href="#" data-gozones>Zones</a>' : '') : '')
          + UI.notice(esc(accessNote(conn)), 'ok')
          + UI.tabs([{ id: 'settings', label: 'Settings' }, { id: 'allow', label: 'Schema allow-list' }].concat(canDesign ? [{ id: 'designer', label: 'Schema designer' }] : []).concat(hasQueues ? [{ id: 'queues', label: 'Queues', count: D.queueCount(st, conn) }] : []).concat([{ id: 'sync', label: 'Sync', count: conn.syncs.length }, { id: 'browser', label: 'Browser' }, { id: 'queries', label: 'Saved queries' }]), st.tab)
          + (st.tab === 'settings' ? settings() : st.tab === 'allow' ? allow() : st.tab === 'designer' ? (st.designerView = D.designerTab(ctx, conn, st, () => ctx.rerender(), load)).html : st.tab === 'queues' ? (st.queuesView = D.queuesTab(ctx, conn, st, () => ctx.rerender(), load)).html : st.tab === 'sync' ? sync() : st.tab === 'queries' ? (st.queriesView = App.connectionSources.queriesTab(ctx, conn, st, () => ctx.rerender())).html : browser()))
        + '</div>';

      // ---- events ----
      ctx.on('click', '[data-register]', () => openRegister());
      ctx.on('click', '[data-conn]', (e, t) => { st.conn = t.dataset.conn; st.restSel = null; st.editing = false; ctx.rerender(); });
      ctx.on('click', '[data-restconn]', (e, t) => { st.restSel = t.dataset.restconn; ctx.rerender(); });
      const registered = (c) => { st.restSel = c.id; st.restLoaded = false; ctx.rerender(); };
      ctx.on('click', '[data-registerrest]', () => App.connectionSources.registerRest(registered, 'rest'));
      ctx.on('click', '[data-registerapi]', (e, t) => App.connectionSources.registerRest(registered, t.dataset.registerapi));
      ctx.on('click', '[data-cgroup]', (e, t) => { const g = t.dataset.cgroup; st.groupsShut[g] = !st.groupsShut[g]; ctx.rerender(); });
      ctx.on('click', '[data-dismissnote]', () => { st.demoNote = null; ctx.rerender(); });
      if (restConn) { st.restView.bind(); return; }
      if (!conn) return;
      if (st.tab === 'queries' && st.queriesView) st.queriesView.bind();
      if (st.tab === 'designer' && st.designerView) st.designerView.bind();
      if (st.tab === 'queues' && st.queuesView) st.queuesView.bind();
      if (st.tab === 'settings' && st.adminView) st.adminView.bind();
      ctx.on('click', '[data-tab]', (e, t) => { st.tab = t.dataset.tab; ctx.rerender(); });
      ctx.on('click', '[data-obj]', (e, t) => { st.treeOpen = t.dataset.obj; st.sqlBy[conn.id] = isSql(conn) ? firstRows(conn, t.dataset.obj, conn.rowLimit) : isMongo(conn) ? mongoFind(t.dataset.obj, conn.rowLimit) : (conn.engine === 'dynamodb' || conn.engine === 'cosmos-nosql') && (infoOf(conn.engine).examples || [])[0] ? infoOf(conn.engine).examples[0].query.split('{object}').join(t.dataset.obj) : 'POST /' + t.dataset.obj + '/_search\n{\n  "size": ' + conn.rowLimit + ',\n  "query": { "match_all": {} }\n}'; delete st.results[conn.id]; st.editing = false; st.tab = 'browser'; ctx.rerender(); });
      ctx.on('click', '[data-example]', (e, t) => { const x = exs.find((y) => y.id === t.dataset.example); st.sqlBy[conn.id] = x.q; delete st.results[conn.id]; st.editing = false; ctx.rerender(); });
      ctx.on('click', '[data-editsql], [data-code]', () => { st.editing = true; ctx.rerender(); const ta = ctx.$('[data-sqledit]'); if (ta) ta.focus(); });
      ctx.on('input', '[data-sqledit]', (e, t) => { st.sqlBy[conn.id] = t.value; });
      ctx.on('click', '[data-doneedit]', () => { st.editing = false; ctx.rerender(); });
      const run = async (confirmUnparsed) => {
        const ta = ctx.$('[data-sqledit]'); if (ta) st.sqlBy[conn.id] = ta.value;
        const q = (st.sqlBy[conn.id] || '').trim(); if (!q) { toast('Write a query first.'); return; }
        st.running = true; st.editing = false; ctx.rerender();
        const id = conn.id;
        try {
          const o = await App.post('/api/admin/connections/' + enc(id) + '/query', { query: q, confirmUnparsed: !!confirmUnparsed });
          st.results[id] = { ok: o, query: q, confirmUnparsed: !!confirmUnparsed };
          toast('Ran on ' + esc(conn.name) + ' as ' + esc(conn.account || 'the read-only account') + '. ' + o.rows.length + ' rows in ' + o.ms + ' ms.', 'ok');
        } catch (err) {
          st.results[id] = { error: err, query: q };
          const p = err.problem || {};
          if (err.status === 422) toast('Refused before it left the server. Audit entry written.', 'danger');
          else if (!(err.status === 409 && p.kind === 'unparsed') && err.status !== 403) App.fail(err);
        }
        st.running = false; later();
      };
      ctx.on('click', '[data-run]', () => run(false));
      ctx.on('click', '[data-runanyway]', async () => { const ok = await ctx.confirm({ title: 'Run as written', tone: 'warn', ok: 'Run on the read-only account', body: '<div class="fg2">The parser could not read this query, so it cannot check the objects it touches. The read-only account and a read-only transaction still apply, and the run is logged as unparsed.</div>' }); if (ok) run(true); });
      ctx.on('click', '[data-aggregate]', () => { const o = allowedObjs.find((x) => (r && r.query || '').indexOf(x.name) >= 0) || allowedObjs[0]; if (!o) return; st.sqlBy[conn.id] = 'SELECT count(*) AS row_count\nFROM ' + o.name + term(conn); delete st.results[conn.id]; st.editing = true; ctx.rerender(); toast('Edit the aggregate (group by a column that matters), then run it.'); });
      ctx.on('click', '[data-export]', async () => {
        if (!r || !r.ok) return;
        const ok = await ctx.confirm({ title: 'Export result', tag: conn.label, tone: 'warn', body: '<p style="margin:0" class="fg2">The query runs again with the same checks; the file carries the connection\'s label and your name, and passes the export checkpoint.</p>', kv: [['Rows', 'up to ' + conn.rowLimit], ['Format', 'CSV, UTF-8'], ['Label', UI.label(conn.label, { sm: true })], ['PII columns', 'masked']], ok: 'Export CSV' });
        if (!ok) return;
        try {
          const res = await fetch('/api/admin/connections/' + enc(conn.id) + '/export', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'text/csv, application/json', 'X-CSRF-Token': App.state.csrf || '' }, body: JSON.stringify({ query: r.query, confirmUnparsed: !!r.confirmUnparsed }) });
          if (!res.ok) { let p = null; try { p = await res.json(); } catch (e2) { /* not JSON */ } throw new App.ApiError(p || { status: res.status, title: res.statusText }); }
          const name = ((res.headers.get('content-disposition') || '').match(/filename="([^"]+)"/) || [])[1] || conn.name + '.csv';
          const url = URL.createObjectURL(await res.blob());
          const a = document.createElement('a'); a.href = url; a.download = name; a.style.display = 'none'; document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 10000);
          toast('Exported <span class="mono">' + esc(name) + '</span>, labelled ' + esc(res.headers.get('x-label') || conn.label) + '. Audit entry written.', 'ok', 5000);
        } catch (err) { App.fail(err, 'Export refused'); }
      });
      ctx.on('click', '[data-test]', async () => {
        toast('Testing ' + esc(conn.endpoint) + ' from zone ' + esc(conn.zone) + '…');
        try { const t = await App.post('/api/admin/connections/' + enc(conn.id) + '/test'); toast(t.ok ? 'Connected in ' + t.ms + ' ms' + (t.version ? ' (' + esc(t.version) + ')' : '') + '. ' + esc(t.detail) : 'Not reachable: ' + esc(t.detail), t.health === 'healthy' ? 'ok' : t.health === 'degraded' ? 'warn' : 'danger', 6000); load(); }
        catch (err) { App.fail(err); }
      });
      ctx.on('click', '[data-refresh]', () => act(() => App.post('/api/admin/connections/' + enc(conn.id) + '/schema')).then((o) => { if (o && o.objects != null) toast('Schema introspected: ' + o.allowed + ' allowed objects, ' + o.outside + ' outside the allow-list.', 'ok'); }));
      ctx.on('click', '[data-usekb]', async () => {
        let bases;
        try { bases = (await App.get('/api/knowledge/bases')).filter((k) => k.access === 'manage'); } catch (err) { App.fail(err); return; }
        if (!allowedObjs.length) { toast('Allow a table or view on the Schema allow-list first.', 'warn'); return; }
        if (!bases.length) { toast('Create a knowledge base on the Knowledge screen first.', 'warn'); return; }
        ctx.modal({ title: 'Use as knowledge source', body: '<p style="margin:0" class="fg2">Adds an allow-listed view or table to a knowledge base. Each row becomes a document; chunks carry at least the connection label (' + esc(conn.label) + ').</p>' + UI.field('Knowledge base', UI.select(bases.map((k) => ({ value: k.id, label: k.name + ' (' + k.label + ')' })), bases[0].id, 'data-kbsel')) + UI.field(isMongo(conn) ? 'Collection' : 'View or table', UI.select(allowedObjs.map((o) => o.name), allowedObjs[0].name, 'data-objsel')) + UI.field('Sync', UI.select([{ value: '15m', label: 'Watermark on updated_at, every 15 min (default)' }, { value: 'hourly', label: 'hourly' }, { value: 'daily', label: 'daily' }, { value: 'manual', label: 'manual' }], '15m', 'data-sched')) + '<div data-err></div>',
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Add source', { kind: 'primary', attrs: 'data-go' }), onMount(m) {
            m.querySelector('[data-go]').addEventListener('click', async () => {
              const kbId = m.querySelector('[data-kbsel]').value; const kb = bases.find((k) => k.id === kbId);
              try { await App.post('/api/knowledge/bases/' + enc(kbId) + '/sources', { kind: 'database', connectionId: conn.id, location: m.querySelector('[data-objsel]').value, schedule: m.querySelector('[data-sched]').value }); App.closeOverlay(); toast('Source added to ' + esc(kb.name) + '. First sync queued as a knowledge.sync job.', 'ok'); load(); setTimeout(() => ctx.navigate('knowledge', { kb: kbId }), 900); }
              catch (err) { m.querySelector('[data-err]').innerHTML = UI.notice('<b>' + esc((err.problem && err.problem.title) || 'Refused') + '.</b> ' + esc(err.message), 'danger'); }
            });
          } });
      });
      ctx.on('click', '[data-gokb]', (e, t) => { e.preventDefault(); ctx.navigate('knowledge', { kb: t.dataset.gokb }); });
      ctx.on('click', '[data-gozones]', (e) => { e.preventDefault(); ctx.navigate('zones'); });
      ctx.on('click', '[data-audit]', (e) => { e.preventDefault(); ctx.navigate('usage-audit'); });
      ctx.on('click', '[data-syncnow]', () => act(() => App.post('/api/admin/connections/' + enc(conn.id) + '/sync')).then((o) => { if (o && o.jobs) toast('knowledge.sync queued for ' + o.jobs.length + ' source' + (o.jobs.length === 1 ? '' : 's') + '. The watermark resumes from the last value.', 'ok'); }));
      ctx.on('click', '[data-save]', () => {
        const body = {};
        ctx.$$('[data-setting]').forEach((i) => { const k = i.dataset.setting; if (i.disabled) return; body[k] = k === 'rowLimit' || k === 'timeoutS' ? Math.round(+i.value) : k === 'database' ? (i.value.trim() || null) : i.value; });
        const tls = ctx.$('[data-setting-tls]'); if (tls && !info.tlsRequired) body.tls = tls.classList.contains('on');
        const of = ctx.$('[data-optsform]'); if (of) body.options = readOptions(of);
        act(() => App.patch('/api/admin/connections/' + enc(conn.id), body)).then((o) => { if (o && o.version) toast('Settings saved as version ' + o.version + '. Audit entry written.', 'ok'); });
      });
      ctx.on('change', '[data-opt]', () => { const of = ctx.$('[data-optsform]'); if (of) applyWhen(of); });
      { const of0 = ctx.$('[data-optsform]'); if (of0) applyWhen(of0); }
      ctx.on('click', '[data-rotate]', () => {
        const cred = info.credential || PW;
        ctx.modal({ title: 'Rotate credential for ' + esc(conn.name), body: (info.dynamicCredentials ? UI.field('Source', UI.select([{ value: 'static', label: 'Sealed account' }, { value: 'openbao', label: 'OpenBao dynamic credentials' }], conn.credentialSource || 'static', 'data-src')) : '') + '<div data-staticwrap>' + UI.field(cred.usernameLabel + (cred.usernameRequired ? '' : ' (optional)'), UI.input(conn.account || '', { attrs: 'data-user autocomplete="off" spellcheck="false"' }), 'A read-only account. An account with write grants shows as degraded on the next test.') + UI.field(cred.secretLabel, secretInput(cred), esc(cred.secretHelp || 'Sealed with the tenant key; it is never shown again.')) + '</div><div data-baowrap>' + UI.field('OpenBao role', UI.input(conn.baoRole || '', { attrs: 'data-role autocomplete="off" placeholder="ledger-readonly"' }), 'A database-engine role that grants SELECT only. Accounts are issued per instance, renewed while used and revoked when dropped.') + '</div><div data-err></div>',
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Replace credential', { kind: 'primary', attrs: 'data-go' }), onMount(m) {
            const src = m.querySelector('[data-src]');
            const sync = () => { const bao = !!src && src.value === 'openbao'; m.querySelector('[data-staticwrap]').hidden = bao; m.querySelector('[data-baowrap]').hidden = !bao; };
            if (src) src.addEventListener('change', sync);
            sync();
            m.querySelector('[data-go]').addEventListener('click', async () => {
              if (src && src.value === 'openbao') {
                const role = m.querySelector('[data-role]').value.trim(); if (!role) { toast('Give the OpenBao role.'); return; }
                try { await App.api('PUT', '/api/admin/connections/' + enc(conn.id) + '/credential', { baoRole: role }); App.closeOverlay(); toast('The connection now takes short-lived accounts from OpenBao role ' + esc(role) + '. Test it to check.', 'ok'); load(); }
                catch (err) { m.querySelector('[data-err]').innerHTML = UI.notice('<b>' + esc((err.problem && err.problem.title) || 'Refused') + '.</b> ' + esc(err.message), 'danger'); }
                return;
              }
              const u = m.querySelector('[data-user]').value.trim(); if (!u && cred.usernameRequired) { toast('Give the ' + esc(cred.usernameLabel.toLowerCase()) + '.'); return; }
              try { await App.api('PUT', '/api/admin/connections/' + enc(conn.id) + '/credential', { username: u || null, password: m.querySelector('[data-pass]').value }); App.closeOverlay(); toast('Credential replaced and sealed. Test the connection to check it.', 'ok'); load(); }
              catch (err) { m.querySelector('[data-err]').innerHTML = UI.notice('<b>' + esc((err.problem && err.problem.title) || 'Refused') + '.</b> ' + esc(err.message), 'danger'); }
            });
          } });
      });
      ctx.on('click', '[data-mask]', () => { toast('PII masking cannot be turned off. Masking of PII-classified columns applies to every result.', 'warn'); });
      ctx.on('click', '[data-remove]', async () => {
        const ok = await ctx.confirm({ title: 'Remove connection', tag: 'destructive', tone: 'danger', body: '<p style="margin:0" class="fg2">' + esc(conn.name) + (conn.syncs.length ? ' is used by ' + conn.syncs.length + ' knowledge source' + (conn.syncs.length === 1 ? '' : 's') + '; remove them first.' : ' is not used by any knowledge source. Its sealed credential is deleted.') + '</p>', ok: 'Remove' });
        if (ok && await act(() => App.del('/api/admin/connections/' + enc(conn.id)), esc(conn.name) + ' removed. Audit entry written.')) st.conn = null;
      });
      ctx.on('change', '[data-allowobj]', (e, t) => { st.allow[conn.id + '|' + t.dataset.allowobj] = t.checked; ctx.rerender(); });
      ctx.on('click', '[data-saveallow]', () => {
        const objects = [];
        ctx.$$('[data-allowobj]').forEach((i) => { if (i.checked) objects.push(i.dataset.allowobj); });
        const np = ctx.$('[data-newpattern]'); if (np && np.value.trim()) objects.push(np.value.trim());
        const pii = (ctx.$('[data-pii]').value || '').split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
        act(() => App.api('PUT', '/api/admin/connections/' + enc(conn.id) + '/allow-list', { objects, piiColumns: pii }), 'Allow-list saved. The schema the model sees is rebuilt.').then((o) => { if (o) Object.keys(st.allow).forEach((k) => { if (k.indexOf(conn.id + '|') === 0) delete st.allow[k]; }); });
      });
      if (st.runNow) { st.runNow = false; setTimeout(() => run(false), 30); }
    }
  });

  function openRegister() {
    const engines = catalogue();
    const first = engines.find((e) => e.id === 'postgres') || engines[0];
    App.modal({
      title: 'Register a connection',
      body: UI.notice(esc(engines.map((e) => e.title).join(', ')) + ' are available. The zone must be one defined under Zones, with a ceiling at or above the label.', 'info')
        + '<div class="formgrid">' + UI.field('Engine', engineSelect(engines, first.id))
        + UI.field('Name', UI.input('', { placeholder: 'for example sales-ro', attrs: 'data-name' })) + UI.field('Endpoint', UI.input('', { placeholder: 'host:port', attrs: 'data-endpoint' }), '<span data-endpointhelp></span>') + '<div data-dbwrap></div>' + UI.field('Network zone', UI.select(ZONES, 'data', 'data-zone'))
        + UI.field('Label ceiling', UI.select(LABELS, 'internal', 'data-label')) + '<div data-srcwrap>' + UI.field('Credentials', UI.select([{ value: 'static', label: 'Sealed account' }, { value: 'openbao', label: 'OpenBao dynamic credentials' }], 'static', 'data-src')) + '</div>'
        + '<div data-staticwrap></div>'
        + '<div data-baowrap>' + UI.field('OpenBao role', UI.input('', { attrs: 'data-role autocomplete="off" placeholder="ledger-readonly"' }), 'GET database/creds/&lt;role&gt; issues a short-lived read-only account.') + '</div>'
        + UI.field('Row limit', UI.input('500', { type: 'number', attrs: 'data-rows' })) + UI.field('Statement timeout, s', UI.input('10', { type: 'number', attrs: 'data-timeout' })) + '</div>'
        + '<div data-optsheading></div><div class="formgrid" data-optswrap></div>'
        + UI.check('Use TLS and verify the server certificate', false, 'data-tls') + '<div data-tlshelp class="muted" style="font-size:12px"></div><div data-err></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Register', { kind: 'primary', attrs: 'data-doreg' }),
      onMount(m) {
        const q = (s) => m.querySelector(s);
        const sel = q('[data-engine]'); const btn = q('[data-doreg]');
        const src = q('[data-src]');
        const tlsBox = q('[data-tls]'); const tlsIn = tlsBox && (tlsBox.matches('input') ? tlsBox : tlsBox.querySelector('input'));
        let shown = null; let tlsBefore = false;
        // Fields that depend on the engine are redrawn when it changes; what was typed in shared fields stays.
        const draw = () => {
          const info = infoOf(sel.value);
          if (shown !== info.id) {
            const db = q('[data-db]'); const dbv = db ? db.value : '';
            const user = q('[data-user]'); const userv = user ? user.value : '';
            const cred = info.credential || PW;
            q('[data-dbwrap]').innerHTML = info.database ? UI.field(info.database.label + (info.database.required ? '' : ' (optional)'), UI.input(dbv, { placeholder: info.database.placeholder || '', attrs: 'data-db autocomplete="off" spellcheck="false"' }), esc(info.database.help || '')) : '';
            q('[data-dbwrap]').hidden = !info.database;
            q('[data-staticwrap]').innerHTML = UI.field(cred.usernameLabel + (cred.usernameRequired ? '' : ' (optional)'), UI.input(userv, { attrs: 'data-user autocomplete="off" spellcheck="false"' }), info.id === 'mongodb' ? 'An account with the read role on the database. It signs in against that database; write authdb/user for another, such as admin/reader. The password may be a vault: reference.' : '') + UI.field(cred.secretLabel, secretInput(cred), esc(cred.secretHelp || 'Sealed with the tenant key; never shown again.'));
            q('[data-optswrap]').innerHTML = optionFields(info, {});
            q('[data-optsheading]').innerHTML = (info.options || []).length ? '<div class="eyebrow" style="margin-top:6px">' + esc(info.title) + ' settings</div>' : '';
            q('[data-endpoint]').placeholder = info.endpointHint || 'host:port';
            q('[data-endpointhelp]').textContent = info.transport === 'https' ? 'Reached over HTTPS through the egress guard; the host must be on the operator\'s CONNECTIONS_ALLOWED_HOSTS.' : '';
            if (tlsIn) {
              if (info.tlsRequired) { if (!tlsIn.disabled) tlsBefore = tlsIn.checked; tlsIn.checked = true; tlsIn.disabled = true; }
              else if (tlsIn.disabled) { tlsIn.disabled = false; tlsIn.checked = tlsBefore; }
            }
            q('[data-tlshelp]').textContent = info.tlsRequired ? info.title + ' connections always use TLS.' : '';
            shown = info.id;
          }
          q('[data-srcwrap]').hidden = !info.dynamicCredentials; if (!info.dynamicCredentials) src.value = 'static';
          const bao = src.value === 'openbao'; q('[data-staticwrap]').hidden = bao; q('[data-baowrap]').hidden = !bao;
          applyWhen(q('[data-optswrap]'));
        };
        sel.addEventListener('change', draw); src.addEventListener('change', draw);
        m.addEventListener('change', (e) => { if (e.target && e.target.matches && e.target.matches('[data-opt]')) applyWhen(q('[data-optswrap]')); });
        draw();
        btn.addEventListener('click', async () => {
          const info = infoOf(sel.value); const cred = info.credential || PW;
          const db = q('[data-db]'); const bao = src.value === 'openbao';
          const body = { name: q('[data-name]').value.trim(), engine: sel.value, endpoint: q('[data-endpoint]').value.trim(), database: info.database && db ? (db.value.trim() || null) : null, zone: q('[data-zone]').value, label: q('[data-label]').value, rowLimit: Math.round(+q('[data-rows]').value || 500), timeoutS: Math.round(+q('[data-timeout]').value || 10), tls: !!(tlsIn && tlsIn.checked), username: bao ? null : (q('[data-user]').value.trim() || null), password: bao ? null : (q('[data-pass]').value || null), baoRole: bao ? (q('[data-role]').value.trim() || null) : null };
          const options = readOptions(q('[data-optswrap]'));
          if (Object.keys(options).length) body.options = options;
          if (bao && !body.baoRole) { App.toast('Give the OpenBao role.'); return; }
          if (!body.name || !body.endpoint) { App.toast('Give the connection a name and an endpoint.'); return; }
          if (info.database && info.database.required && !body.database) { App.toast(info.id === 'mongodb' ? 'Name the MongoDB database the connection reads.' : 'Give the ' + esc(info.database.label.toLowerCase()) + '.'); return; }
          if (!bao && body.password && cred.usernameRequired && !body.username) { App.toast('Give the ' + esc(cred.usernameLabel.toLowerCase()) + '.'); return; }
          try {
            const c = await App.post('/api/admin/connections', body);
            App.closeOverlay();
            const st = App.stateFor('connections'); st.loaded = false; st.conn = c.id; st.tab = 'allow';
            App.toast('<span>Connection registered. Test it, then introspect the schema to build the allow-list.</span>', 'ok');
            App.render();
          } catch (err) { q('[data-err]').innerHTML = UI.notice('<b>' + esc((err.problem && err.problem.title) || 'Not registered') + '.</b> ' + esc(err.message), 'danger'); }
        });
      }
    });
  }
})();
