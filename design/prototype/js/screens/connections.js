(function () {
  const { UI, esc } = App;

  const CONNS = [
    { id: 'ledger-ro', engine: 'Postgres 17', type: 'postgres', zone: 'data', label: 'confidential', health: 'healthy', endpoint: 'pg-ledger.northwind.internal:5432', cred: 'ledger-ro-dynamic (OpenBao, 1 h lease)', ops: 'read', rowLimit: 500, timeout: 10, sync: 'Sync: watermark on updated_at, last value 19 Sep 12:02.',
      schema: [
        { name: 'ledger.v_cost_centres', cols: [['cost_centre', 'text'], ['q3_actual', 'numeric'], ['q3_budget', 'numeric']] },
        { name: 'ledger.v_suppliers', cols: [['name', 'text'], ['iban', 'text', 'PII, masked'], ['contact_email', 'text', 'PII, masked']] }
      ],
      denied: ['ledger.card_feed', 'ledger.payroll_lines'],
      question: 'which cost centres overran in Q3?',
      query: 'SELECT cost_centre, q3_actual, q3_budget,\n       q3_actual - q3_budget AS overrun\nFROM ledger.v_cost_centres\nWHERE q3_actual > q3_budget\nORDER BY overrun DESC\nLIMIT 500;',
      lang: 'sql',
      result: { cols: ['cost_centre', 'q3_actual', 'q3_budget', 'overrun'], rows: [['FIELD-SALES', '188,420.00', '150,000.00', '38,420.00'], ['LIS-ONBOARD', '96,310.00', '60,000.00', '36,310.00'], ['EXEC-TRAVEL', '41,200.00', '38,000.00', '3,200.00']], ms: 42 },
      syncs: [{ target: 'Finance KB', source: 'ledger.v_cost_centres', mode: 'Watermark on updated_at', last: '19 Sep 12:02', status: 'synced', rows: '1,204 rows' }, { target: 'Finance KB', source: 'ledger.v_suppliers', mode: 'Watermark on updated_at', last: '19 Sep 12:02', status: 'synced', rows: '388 rows' }, { target: 'Data analyst agent memory', source: 'ledger.v_cost_centres', mode: 'Logical replication', last: 'live', status: 'active', rows: 'slot exprsn_ledger' }] },
    { id: 'hr-warehouse', engine: 'Postgres 16', type: 'postgres', zone: 'data', label: 'restricted', health: 'healthy', endpoint: 'pg-hr.northwind.internal:5432', cred: 'hr-ro-dynamic (OpenBao, 1 h lease)', ops: 'read', rowLimit: 200, timeout: 10, sync: 'Sync: no knowledge source uses this connection.',
      schema: [{ name: 'hr.v_headcount', cols: [['cost_centre', 'text'], ['fte', 'numeric']] }, { name: 'hr.v_salary_bands', cols: [['band', 'text'], ['min_eur', 'numeric', 'PII, masked'], ['max_eur', 'numeric', 'PII, masked']] }],
      denied: ['hr.employees', 'hr.payroll'], question: '', query: '', lang: 'sql', result: null, syncs: [] },
    { id: 'app-logs', engine: 'OpenSearch 2.x', type: 'opensearch', zone: 'data', label: 'internal', health: 'healthy', endpoint: 'os-logs.northwind.internal:9200', cred: 'logs-reader (OpenBao static, rotated weekly)', ops: 'read', rowLimit: 500, timeout: 10, sync: 'Sync: searchable copy of gateway logs and the audit chain, 90 day retention.',
      schema: [{ name: 'gateway-logs-*', cols: [['@timestamp', 'date'], ['level', 'keyword'], ['service', 'keyword'], ['trace_id', 'keyword'], ['message', 'text']] }, { name: 'audit-*', cols: [['@timestamp', 'date'], ['actor', 'keyword', 'PII, masked'], ['action', 'keyword'], ['resource', 'keyword']] }],
      denied: ['security-*'], question: 'gateway errors in the last hour', query: '{\n  "size": 500,\n  "query": { "bool": { "filter": [\n    { "term": { "level": "error" } },\n    { "range": { "@timestamp": { "gte": "now-1h" } } }\n  ] } },\n  "sort": [{ "@timestamp": "desc" }]\n}', lang: 'json',
      result: { cols: ['@timestamp', 'level', 'service', 'message'], rows: [['19 Sep 14:02:11', 'error', 'guard', 'llama-guard3:8b: connection refused, fail closed for confidential turn'], ['19 Sep 13:48:40', 'error', 'gateway', 'route refused: model ceiling internal below conversation label confidential'], ['19 Sep 13:31:05', 'error', 'ingest', 'quarantine scan timed out for upload u-8812']], ms: 118 },
      syncs: [{ target: 'Usage and audit', source: 'audit-*', mode: 'Searchable copy', last: '19 Sep 14:10', status: 'synced', rows: '2.1 M documents' }] },
    { id: 'contracts-index', engine: 'OpenSearch 2.x', type: 'opensearch', zone: 'data', label: 'confidential', health: 'degraded', endpoint: 'os-contracts.northwind.internal:9200', cred: 'contracts-reader (OpenBao static, rotated weekly)', ops: 'read', rowLimit: 500, timeout: 10, sync: 'Sync: Contracts KB retrieval index, k-NN plus BM25 hybrid, one replica missing.',
      schema: [{ name: 'contracts-v3', cols: [['doc_id', 'keyword'], ['title', 'text'], ['counterparty', 'keyword'], ['embedding', 'knn_vector 768'], ['label', 'keyword']] }],
      denied: [], question: 'contracts with Fabrikam that mention termination', query: '{\n  "size": 500,\n  "query": { "bool": { "must": [\n    { "match": { "counterparty": "Fabrikam" } },\n    { "match_phrase": { "body": "terminate for convenience" } }\n  ] } }\n}', lang: 'json',
      result: { cols: ['doc_id', 'title', 'counterparty', 'label'], rows: [['ctr-2025-041', 'Fabrikam MSA 2025.pdf', 'Fabrikam', 'internal'], ['ctr-2024-118', 'Fabrikam SOW 3.pdf', 'Fabrikam', 'confidential']], ms: 64 },
      syncs: [{ target: 'Contracts KB', source: 'contracts-v3', mode: 'Retrieval index', last: '19 Sep 09:15', status: 'degraded', rows: '4,812 chunks, replica 1 of 2' }] }
  ];
  const EXAMPLES = {
    postgres: [
      { id: 'overrun', label: 'Overruns in Q3', sql: null },
      { id: 'suppliers', label: 'Suppliers with an IBAN', sql: 'SELECT name, iban, contact_email\nFROM ledger.v_suppliers\nWHERE iban IS NOT NULL\nLIMIT 500;' },
      { id: 'update', label: 'UPDATE (write)', sql: 'UPDATE ledger.v_cost_centres\nSET q3_budget = q3_actual\nWHERE cost_centre = \'LIS-ONBOARD\';' },
      { id: 'ddl', label: 'DROP TABLE (DDL)', sql: 'DROP TABLE ledger.card_feed;' },
      { id: 'denied', label: 'Table outside the allow-list', sql: 'SELECT * FROM ledger.payroll_lines LIMIT 10;' }
    ],
    opensearch: [
      { id: 'default', label: 'Generated query', sql: null },
      { id: 'delete', label: 'delete_by_query (write)', sql: 'POST /gateway-logs-*/_delete_by_query\n{ "query": { "term": { "level": "error" } } }' },
      { id: 'ddl', label: 'Delete index (DDL)', sql: 'DELETE /gateway-logs-2026.09.19' }
    ]
  };

  function classify(conn, sql) {
    const s = String(sql || '').trim();
    const head = s.replace(/^\s*(POST|PUT|DELETE|GET)\s+\S+\s*/i, (m) => m).toUpperCase();
    if (/^(DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE)\b/.test(head) || /^DELETE\s+\/\S+\s*$/i.test(s) || /^PUT\s+\/\S+/.test(s)) return { kind: 'ddl', verb: head.split(/\s+/)[0] };
    if (/^(UPDATE|INSERT|DELETE|MERGE)\b/.test(head) || /_delete_by_query|_update_by_query|_bulk/.test(s)) return { kind: 'write', verb: /_delete_by_query/.test(s) ? 'delete_by_query' : head.split(/\s+/)[0] };
    if (conn.type === 'postgres' && /\$\$|::vendor|\bMERGE\b|\bPIVOT\b/i.test(s)) return { kind: 'unparsed' };
    const bad = (conn.denied || []).find((d) => s.includes(d));
    if (bad) return { kind: 'denied', object: bad };
    return { kind: 'ok' };
  }

  App.register({
    id: 'connections', title: 'Connections', summary: 'Database and search connections, schema allow-lists, sync status, data browser', section: 'admin',
    crumb: (st) => ['Admin', 'Connections', (CONNS.find((c) => c.id === st.conn) || CONNS[0]).id],
    label: (st) => (CONNS.find((c) => c.id === st.conn) || CONNS[0]).label,
    commands: [
      { label: 'Register a connection', sub: 'Connections', run(app) { app.stateFor('connections').register = true; app.render(); } },
      { label: 'Open the data browser', sub: 'Connections', run(app) { const s = app.stateFor('connections'); s.tab = 'browser'; app.render(); } }
    ],
    states: [
      { title: 'Parser could not read it', tone: 'warn', text: 'The query uses vendor syntax the parser does not know. The user sees the query and confirms before it runs on the read-only account.', apply(ctx) { const st = ctx.state; st.conn = 'ledger-ro'; st.tab = 'browser'; st.sql = 'SELECT cost_centre, q3_actual::vendor_money AS actual\nFROM ledger.v_cost_centres\nWHERE q3_actual > q3_budget $$ hint(index=cc_q3) $$;'; st.result = { kind: 'unparsed' }; ctx.rerender(); } },
      { title: 'Write refused', tone: 'danger', text: 'An UPDATE was proposed on a read-only connection. The database would refuse it, so it is not sent.', apply(ctx) { const st = ctx.state; st.conn = 'ledger-ro'; st.tab = 'browser'; st.sql = EXAMPLES.postgres[2].sql; st.result = { kind: 'write', verb: 'UPDATE' }; ctx.rerender(); } },
      { title: 'Row cap reached', tone: 'neutral', text: '500 of an estimated 12,000 rows returned, with a prompt to aggregate instead.', apply(ctx) { const st = ctx.state; st.conn = 'ledger-ro'; st.tab = 'browser'; st.sql = 'SELECT *\nFROM ledger.v_cost_centres\nORDER BY cost_centre;'; st.result = { kind: 'capped' }; ctx.rerender(); } },
      { title: 'Two engines', tone: 'info', text: 'Register offers Postgres and OpenSearch only.', apply(ctx) { ctx.state.register = true; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      if (ctx.params.conn) { st.conn = ctx.params.conn; delete ctx.params.conn; }
      if (ctx.params.tab) { st.tab = ctx.params.tab; delete ctx.params.tab; }
      st.conn = st.conn || 'ledger-ro'; st.tab = st.tab || 'browser'; st.allow = st.allow || {}; st.sqlBy = st.sqlBy || {};
      if (st.result === undefined) st.result = { kind: 'ok', conn: 'ledger-ro' };
      const conn = CONNS.find((c) => c.id === st.conn) || CONNS[0];
      const above = conn.label === 'restricted';
      if (st.sql == null || st.sqlConn !== conn.id) { st.sql = st.sqlBy[conn.id] || conn.query; st.sqlConn = conn.id; if (st.result && st.result.conn !== conn.id) st.result = null; }
      st.sqlBy[conn.id] = st.sql;

      const schemaTree = '<div class="panel" style="gap:4px"><div class="phead"><div class="eyebrow">Allowed schema</div>' + UI.btn('Allow-list', { kind: 'ghost', size: 'xs', attrs: 'data-tab="allow"' }) + '</div>'
        + conn.schema.map((t) => '<div class="conn-tree"><button type="button" class="conn-obj' + (st.treeOpen === t.name ? ' on' : '') + '" data-obj="' + esc(t.name) + '">' + UI.icon('chevd', 12) + '<span class="mono">' + esc(t.name) + '</span></button>' + t.cols.map((c) => '<div class="conn-col"><span class="mono">' + esc(c[0]) + ' <span class="muted">' + esc(c[1]) + '</span></span>' + (c[2] ? UI.pill(c[2], 'warn') : '') + '</div>').join('') + '</div>').join('')
        + (conn.denied.length ? '<div class="muted" style="font-size:12px;margin-top:6px">Not on the allow-list: ' + conn.denied.map((d) => '<span class="mono">' + esc(d) + '</span>').join(', ') + '</div>' : '') + '</div>';

      const r = st.result && st.result.conn === conn.id ? st.result : (st.result && !st.result.conn ? st.result : null);
      let resultHtml = '';
      if (above) resultHtml = UI.notice('This connection is labelled <b>restricted</b> and your clearance is confidential. The schema is listed; queries and results are withheld.', 'warn', UI.btn('Request clearance', { size: 'sm', attrs: 'data-clearance' }));
      else if (!r) resultHtml = '<div class="muted" style="font-size:12px">Run the query to see results. Row limit ' + conn.rowLimit + ', timeout ' + conn.timeout + ' s, results labelled ' + esc(conn.label) + '.</div>';
      else if (r.kind === 'ok' || r.kind === 'capped') {
        const res = conn.result; const capped = r.kind === 'capped';
        const rows = capped ? [['CC-0001', '12,004.10', '12,000.00', '4.10'], ['CC-0002', '8,410.00', '9,000.00', '-590.00'], ['CC-0003', '31,208.40', '30,000.00', '1,208.40']].concat([['…', '…', '…', '…']]) : res.rows;
        resultHtml = (capped ? UI.notice('<b>Row cap reached.</b> 500 of an estimated 12,000 rows returned. Aggregate instead so the model sees the whole picture.', 'info', UI.btn('Aggregate instead', { size: 'sm', attrs: 'data-aggregate' })) : '')
          + UI.table(res.cols, rows.map((row) => row.map((c) => esc(c))), { clickable: false, minWidth: '0' })
          + '<span class="muted" style="font-size:12px">' + (capped ? '500 rows (capped), 380 ms. ' : res.rows.length + ' rows, ' + res.ms + ' ms. ') + esc(conn.sync) + '</span>';
      } else if (r.kind === 'ddl') resultHtml = UI.problem('DDL refused', 'The parser read a ' + r.verb + ' statement. Schema changes are never sent to a registered connection, whatever the tool\'s side-effect class. Nothing reached ' + conn.endpoint + '.', 'c0a8011f4d2e4b1e9a7d3f5c2b6e8a10') + '<div class="muted" style="font-size:12px">Refusals are written to the audit log with the query text and the actor. <a href="#" data-audit>Open in Usage and audit</a></div>';
      else if (r.kind === 'write') resultHtml = UI.problem('Write refused', 'An ' + r.verb + ' was proposed on a read-only connection. The database account would refuse it, so it is not sent. Allow writes on a separate connection with a write account and a tool whose side-effect class permits them.', '7d1c3e9a5b2f4e8c9a0b1d2e3f4a5b6c') + '<div class="muted" style="font-size:12px">Refusals are written to the audit log with the query text and the actor. <a href="#" data-audit>Open in Usage and audit</a></div>';
      else if (r.kind === 'denied') resultHtml = UI.problem('Object outside the allow-list', r.object + ' is not on the schema allow-list for ' + conn.id + '. Add it under Schema allow-list, which needs a connection admin.', 'e2b4c6d8f0a1b3c5d7e9f1a3b5c7d9e1');
      else if (r.kind === 'unparsed') resultHtml = UI.notice('<b>Parser could not read it.</b> The query uses syntax node-sql-parser does not know (<span class="mono">::vendor_money</span>, <span class="mono">$$ hint $$</span>). Read-only is still enforced by the database account. Confirm to run it as written.', 'warn', UI.btn('Run on the read-only account', { size: 'sm', attrs: 'data-runanyway' }) + UI.btn('Edit', { kind: 'ghost', size: 'sm', attrs: 'data-editsql' }));
      else if (r.kind === 'run-anyway') resultHtml = UI.table(['cost_centre', 'actual'], [['FIELD-SALES', '188,420.00'], ['LIS-ONBOARD', '96,310.00'], ['EXEC-TRAVEL', '41,200.00']], { clickable: false, minWidth: '0' }) + '<span class="muted" style="font-size:12px">3 rows, 51 ms, ran unparsed on ledger-ro-dynamic. Logged as an unparsed query in the audit chain.</span>';
      else if (r.kind === 'aggregate') resultHtml = UI.table(['cost_centre_group', 'centres', 'q3_actual', 'q3_budget'], [['Sales', '312', '2,104,220.00', '1,980,000.00'], ['Operations', '488', '3,911,004.50', '4,020,000.00'], ['Corporate', '204', '1,206,110.00', '1,150,000.00']], { clickable: false, minWidth: '0' }) + '<span class="muted" style="font-size:12px">3 rows, 96 ms. Grouped by cost centre prefix instead of listing 12,000 rows.</span>';

      const examples = EXAMPLES[conn.type] || [];
      const browser = above
        ? '<div class="cols"><div style="width:270px;flex-shrink:0">' + schemaTree + '</div><div class="vstack grow">' + resultHtml + '</div></div>'
        : '<div class="cols"><div style="width:270px;flex-shrink:0">' + schemaTree + '</div>'
        + '<div class="vstack grow" style="gap:10px"><div class="hstack wrap"><div class="eyebrow">Query</div><span class="muted" style="font-size:12px">' + (st.sql === conn.query ? 'Generated from: ' + esc(conn.question) : 'Edited by Mara Okafor') + '</span><span class="right hstack gap6 wrap">' + examples.map((x) => UI.chip(esc(x.label), (x.sql || conn.query) === st.sql, 'data-example="' + x.id + '"')).join('') + '</span></div>'
        + (st.editing ? '<textarea class="textarea mono" data-sqledit style="min-height:126px;white-space:pre">' + esc(st.sql) + '</textarea>' : '<div data-code style="cursor:text" title="Click to edit">' + UI.code(st.sql, conn.lang) + '</div>')
        + '<div class="hstack wrap">' + UI.btn('Run query', { kind: 'primary', icon: 'play', attrs: 'data-run' }) + UI.btn('Export', { icon: 'download', attrs: 'data-export' + (r && (r.kind === 'ok' || r.kind === 'capped' || r.kind === 'aggregate' || r.kind === 'run-anyway') ? '' : ' disabled') }) + (st.editing ? UI.btn('Done editing', { kind: 'ghost', attrs: 'data-doneedit' }) : UI.btn('Edit', { kind: 'ghost', attrs: 'data-editsql' })) + '<span class="muted" style="font-size:12px">Row limit ' + conn.rowLimit + ', timeout ' + conn.timeout + ' s, results labelled ' + esc(conn.label) + '</span></div>'
        + resultHtml + '</div></div>';

      const settings = '<div class="panel"><div class="formgrid" style="--cols:3">'
        + UI.field('Type', UI.select([{ value: 'postgres', label: 'PostgreSQL' }, { value: 'opensearch', label: 'OpenSearch' }], conn.type, 'disabled'), 'Fixed after registration')
        + UI.field('Endpoint', UI.input(conn.endpoint, { attrs: 'data-setting="endpoint"' }))
        + UI.field('Network zone', UI.select(['data', 'core', 'gpu', 'edge'], conn.zone, 'data-setting="zone"'))
        + UI.field('Credential reference', UI.input(conn.cred, { attrs: 'data-setting="cred" class="input mono"' }), 'OpenBao path. Dynamic credentials are preferred where a secrets engine exists.')
        + UI.field('Label ceiling', UI.select(['public', 'internal', 'confidential', 'restricted'], conn.label, 'data-setting="label"'), 'Results carry this label. Conversations above it cannot use the connection.')
        + UI.field('Allowed operations', UI.select([{ value: 'read', label: 'Read only (default)' }, { value: 'write', label: 'Read and write, separate account' }], conn.ops, 'data-setting="ops"'))
        + UI.field('Row limit', UI.input(String(conn.rowLimit), { type: 'number', attrs: 'data-setting="rowLimit"' }))
        + UI.field('Statement timeout, s', UI.input(String(conn.timeout), { type: 'number', attrs: 'data-setting="timeout"' }))
        + UI.field('PII masking', UI.toggle('Mask PII-classified columns in every result', true, 'data-manual data-mask'))
        + '</div><div class="hstack">' + UI.btn('Save settings', { kind: 'primary', attrs: 'data-save' }) + UI.btn('Rotate credential now', { attrs: 'data-rotate' }) + UI.btn('Remove connection', { kind: 'danger', attrs: 'data-remove' }) + '</div></div>';

      const allowRows = conn.schema.concat(conn.denied.map((d) => ({ name: d, cols: [], denied: true }))).map((t) => { const on = st.allow[conn.id + t.name] != null ? st.allow[conn.id + t.name] : !t.denied; return { cells: [UI.check('', on, 'data-allowobj="' + esc(t.name) + '"'), '<span class="mono">' + esc(t.name) + '</span>', t.cols.length ? t.cols.length + ' columns' : (conn.type === 'postgres' ? 'table' : 'index pattern'), t.cols.some((c) => c[2]) ? UI.pill('PII masked', 'warn') : (t.denied ? UI.pill('not introspected') : UI.pill('clean', 'ok')), on ? UI.pill('allowed', 'ok') : UI.pill('refused', 'danger')] }; });
      const allow = '<div class="vstack" style="gap:10px">' + UI.notice('Only allow-listed objects appear in the introspected schema the model sees. Everything else is refused before the query is sent.', 'info')
        + UI.table(['', 'Object', 'Shape', 'Classification', 'Queries'], allowRows, { clickable: false, minWidth: '0' })
        + '<div class="hstack">' + UI.btn('Save allow-list', { kind: 'primary', attrs: 'data-saveallow' }) + '<span class="muted" style="font-size:12px">Schema introspected 19 Sep 12:02. Refresh schema after a migration.</span></div></div>';

      const syncRows = conn.syncs.map((s) => [ '<a href="#" data-gokb>' + esc(s.target) + '</a>', '<span class="mono">' + esc(s.source) + '</span>', esc(s.mode), esc(s.last), esc(s.rows), UI.pill(s.status) ]);
      const sync = '<div class="vstack" style="gap:10px">' + UI.table(['Target', 'Source object', 'Mode', 'Last sync', 'Volume', 'Status'], syncRows, { clickable: false, minWidth: '0', emptyTitle: 'Nothing syncs from this connection', emptyText: 'Use as knowledge source to add a table or index to a knowledge base.' })
        + '<div class="hstack">' + UI.btn('Sync now', { attrs: 'data-syncnow' }) + '<span class="muted" style="font-size:12px">Source row permissions map to chunk ACLs, so retrieval respects them. ' + (conn.type === 'postgres' ? 'Near-real-time uses logical replication.' : 'The index is the retrieval index itself.') + '</span></div></div>';

      root.innerHTML = '<style>'
        + '#main > .page > *{flex-shrink:0}'
        + '#main .conn-left{width:300px}'
        + '#main .conn-tree{display:flex;flex-direction:column;gap:2px;margin-bottom:6px}'
        + '#main .conn-obj{display:flex;align-items:center;gap:4px;border:0;background:transparent;padding:4px 4px;border-radius:4px;cursor:pointer;font-weight:500;color:var(--fg);text-align:left;font-family:inherit}#main .conn-obj:hover{background:var(--sel)}'
        + '#main .conn-col{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:2px 4px 2px 22px;color:var(--fg2)}'
        + '#main .conn-list{display:flex;flex-direction:column;gap:2px}'
        + '</style>'
        + '<div class="leftpane conn-left"><div class="hstack"><div class="eyebrow grow">Connections</div>' + UI.btn('Register', { size: 'sm', attrs: 'data-register' }) + '</div>'
        + '<div class="conn-list">' + CONNS.map((c) => UI.listItem(esc(c.id), esc(c.engine) + (c.zone ? ', zone ' + esc(c.zone) : ''), { active: c.id === conn.id, attrs: 'data-conn="' + c.id + '"', right: UI.label(c.label, { sm: true }) })).join('') + '</div>'
        + '<div class="divider"></div><div class="muted" style="font-size:12px">PostgreSQL stays the system of record. MySQL and MongoDB connections arrive with the next import bundle.</div></div>'
        + '<div class="page">'
        + UI.pagehead(conn.id, esc(conn.endpoint) + ', credential ref ' + esc(conn.cred) + ' ' + UI.pill(conn.health), UI.btn('Test connection', { attrs: 'data-test' }) + UI.btn('Refresh schema', { icon: 'refresh', attrs: 'data-refresh' }) + UI.btn('Use as knowledge source', { kind: 'primary', attrs: 'data-usekb' }))
        + (conn.health === 'degraded' ? UI.notice('One replica of <span class="mono">contracts-v3</span> is missing on os-contracts-2. Queries still answer from the primary; retrieval latency is up 40 ms.', 'warn', '<a href="#" data-gozones>Zones</a>') : '')
        + UI.notice('Read-only is enforced by the database account and its grants. The query parser is advisory.', 'ok')
        + UI.tabs([{ id: 'settings', label: 'Settings' }, { id: 'allow', label: 'Schema allow-list' }, { id: 'sync', label: 'Sync', count: conn.syncs.length }, { id: 'browser', label: 'Browser' }], st.tab)
        + (st.tab === 'settings' ? settings : st.tab === 'allow' ? allow : st.tab === 'sync' ? sync : browser)
        + '<div style="margin-top:auto"><div class="eyebrow" style="margin-bottom:8px">States to design from this page</div>' + UI.states(this.states) + '</div></div>';

      if (st.register) { st.register = false; openRegister(ctx); }

      // ---- events ----
      ctx.on('click', '[data-conn]', (e, t) => { st.conn = t.dataset.conn; st.editing = false; ctx.rerender(); });
      ctx.on('click', '[data-tab]', (e, t) => { st.tab = t.dataset.tab; ctx.rerender(); });
      ctx.on('click', '[data-obj]', (e, t) => { st.treeOpen = t.dataset.obj; if (!st.editing) { st.sql = (conn.type === 'postgres' ? 'SELECT *\nFROM ' + t.dataset.obj + '\nLIMIT ' + conn.rowLimit + ';' : '{\n  "size": ' + conn.rowLimit + ',\n  "query": { "match_all": {} }\n}'); st.result = null; st.tab = 'browser'; ctx.rerender(); } });
      ctx.on('click', '[data-example]', (e, t) => { const x = examples.find((y) => y.id === t.dataset.example); st.sql = x.sql || conn.query; st.result = null; st.editing = false; ctx.rerender(); });
      ctx.on('click', '[data-editsql], [data-code]', () => { st.editing = true; ctx.rerender(); const ta = ctx.$('[data-sqledit]'); if (ta) ta.focus(); });
      ctx.on('input', '[data-sqledit]', (e, t) => { st.sql = t.value; st.sqlBy[conn.id] = t.value; });
      ctx.on('click', '[data-doneedit]', () => { st.editing = false; ctx.rerender(); });
      ctx.on('click', '[data-run]', () => {
        const ta = ctx.$('[data-sqledit]'); if (ta) st.sql = ta.value;
        const c = classify(conn, st.sql); c.conn = conn.id; st.result = c; st.editing = false; ctx.rerender();
        if (c.kind === 'ok') ctx.toast('Ran on ' + esc(conn.id) + ' as ' + esc(conn.cred.split(' ')[0]) + '. ' + conn.result.rows.length + ' rows in ' + conn.result.ms + ' ms.', 'ok');
        else if (c.kind === 'ddl' || c.kind === 'write') ctx.toast('Refused before it left the gateway. Audit entry written.', 'danger');
        else if (c.kind === 'denied') ctx.toast('Refused: object not on the allow-list.', 'warn');
      });
      ctx.on('click', '[data-runanyway]', () => { st.result = { kind: 'run-anyway', conn: conn.id }; ctx.rerender(); ctx.toast('Ran unparsed on the read-only account. Logged.', 'ok'); });
      ctx.on('click', '[data-aggregate]', () => { st.sql = 'SELECT split_part(cost_centre, \'-\', 1) AS cost_centre_group,\n       count(*) AS centres,\n       sum(q3_actual) AS q3_actual, sum(q3_budget) AS q3_budget\nFROM ledger.v_cost_centres\nGROUP BY 1 ORDER BY 3 DESC;'; st.result = { kind: 'aggregate', conn: conn.id }; ctx.rerender(); });
      ctx.on('click', '[data-export]', async () => {
        const n = st.result && st.result.kind === 'capped' ? '500' : String((conn.result || { rows: [] }).rows.length);
        const ok = await ctx.confirm({ title: 'Export result', tag: conn.label, tone: 'warn', body: '<p style="margin:0" class="fg2">The file carries the connection\'s label and your name. Export runs through the export and delivery checkpoint of Finance baseline v12.</p>', kv: [['Rows', n], ['Format', 'CSV, UTF-8'], ['Label', UI.label(conn.label, { sm: true })], ['PII columns', 'masked']], ok: 'Export CSV' });
        if (ok) ctx.toast('Exported ' + n + ' rows as <span class="mono">' + esc(conn.id) + '-' + esc(new Date().toISOString().slice(0, 10)) + '.csv</span>, labelled ' + esc(conn.label) + '. Audit entry written.', 'ok', 5000);
      });
      ctx.on('click', '[data-test]', () => { ctx.toast('Testing ' + esc(conn.endpoint) + ' from zone ' + esc(conn.zone) + '…'); setTimeout(() => ctx.toast(conn.health === 'healthy' ? 'Connected in 18 ms. Account is read-only; 2 grants checked.' : 'Connected in 41 ms. Cluster status yellow: 1 replica unassigned.', conn.health === 'healthy' ? 'ok' : 'warn'), 900); });
      ctx.on('click', '[data-refresh]', () => { ctx.toast('Schema introspected: ' + conn.schema.length + ' allowed objects, ' + conn.denied.length + ' outside the allow-list. Cached for the model.', 'ok'); });
      ctx.on('click', '[data-usekb]', async () => {
        const ok = await ctx.confirm({ title: 'Use as knowledge source', tag: conn.label, tone: 'warn', body: '<p style="margin:0" class="fg2">Adds the allow-listed objects to a knowledge base. Chunks inherit the connection label and the source row permissions.</p>' + UI.field('Knowledge base', UI.select(['Finance KB', 'Contracts KB', 'Policy KB', 'New knowledge base'], conn.type === 'opensearch' && conn.id === 'contracts-index' ? 'Contracts KB' : 'Finance KB')) + UI.field('Sync mode', UI.select(['Watermark on updated_at (default)', conn.type === 'postgres' ? 'Logical replication (near real time)' : 'Index is the retrieval index'], 'Watermark on updated_at (default)')), ok: 'Add source' });
        if (ok) { ctx.toast('Source added to Finance KB. First sync queued as a knowledge.sync job.', 'ok'); setTimeout(() => ctx.navigate('knowledge'), 900); }
      });
      ctx.on('click', '[data-gokb]', (e) => { e.preventDefault(); ctx.navigate('knowledge'); });
      ctx.on('click', '[data-gozones]', (e) => { e.preventDefault(); ctx.navigate('zones'); });
      ctx.on('click', '[data-audit]', (e) => { e.preventDefault(); ctx.navigate('usage-audit'); });
      ctx.on('click', '[data-syncnow]', () => { ctx.toast('knowledge.sync queued for ' + conn.syncs.length + ' target' + (conn.syncs.length === 1 ? '' : 's') + '. Watermark resumes from the last value.', 'ok'); });
      ctx.on('click', '[data-save]', () => { ctx.$$('[data-setting]').forEach((i) => { const k = i.dataset.setting; conn[k] = /rowLimit|timeout/.test(k) ? +i.value : i.value; }); ctx.toast('Settings saved as version ' + (conn.version = (conn.version || 3) + 1) + '. Audit entry written.', 'ok'); ctx.rerender(); });
      ctx.on('click', '[data-rotate]', () => { ctx.toast('OpenBao issued a new lease. The old credential is revoked in 60 s.', 'ok'); });
      ctx.on('click', '[data-mask]', (e, t) => { if (t.classList.contains('on')) { ctx.toast('PII masking cannot be turned off. Masking of PII-classified columns applies to every result.', 'warn'); } });
      ctx.on('click', '[data-remove]', async () => { const ok = await ctx.confirm({ title: 'Remove connection', tag: 'destructive', body: '<p style="margin:0" class="fg2">' + esc(conn.id) + ' is used by ' + conn.syncs.length + ' sync target' + (conn.syncs.length === 1 ? '' : 's') + ' and the ledger.query tool. They stop working.</p>', ok: 'Remove' }); if (ok) ctx.toast('Refused: ledger.query still references this connection. Retire the tool first.', 'danger', 5000); });
      ctx.on('change', '[data-allowobj]', (e, t) => { st.allow[conn.id + t.dataset.allowobj] = t.checked; ctx.rerender(); });
      ctx.on('click', '[data-saveallow]', () => { ctx.toast('Allow-list saved. The cached schema the model sees is rebuilt.', 'ok'); });
      ctx.on('click', '[data-clearance]', () => { ctx.toast('Request sent to the tenant admin. Clearance comes from your LDAP group, not from this console.'); });
      ctx.on('click', '[data-register]', () => openRegister(ctx));
      ctx.on('click', '.state-card', (e, t) => ctx.app.applyState(+t.dataset.state));
    }
  });

  function openRegister(ctx) {
    ctx.modal({
      title: 'Register a connection',
      body: UI.notice('Two engines are available in this release: PostgreSQL and OpenSearch. MySQL and MongoDB drivers ship in a later import bundle and appear here once verified.', 'info')
        + '<div class="formgrid">' + UI.field('Engine', UI.select([{ value: 'postgres', label: 'PostgreSQL' }, { value: 'opensearch', label: 'OpenSearch' }, { value: 'mysql', label: 'MySQL (not yet available)' }, { value: 'mongodb', label: 'MongoDB (not yet available)' }], 'postgres', 'data-engine'))
        + UI.field('Name', UI.input('', { placeholder: 'for example sales-ro' })) + UI.field('Endpoint', UI.input('', { placeholder: 'host:port' })) + UI.field('Network zone', UI.select(['data', 'core', 'edge'], 'data'))
        + UI.field('Credential reference', UI.input('', { placeholder: 'OpenBao path' })) + UI.field('Label ceiling', UI.select(['public', 'internal', 'confidential', 'restricted'], 'internal')) + '</div>'
        + '<div data-enginewarn></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Register', { kind: 'primary', attrs: 'data-doreg' }),
      onMount(m) {
        const sel = m.querySelector('[data-engine]'); const warn = m.querySelector('[data-enginewarn]'); const btn = m.querySelector('[data-doreg]');
        const check = () => { const off = /mysql|mongodb/.test(sel.value); warn.innerHTML = off ? UI.notice('That engine is not installed on this platform. Register offers Postgres and OpenSearch only.', 'warn') : ''; btn.disabled = off; };
        sel.addEventListener('change', check); check();
        btn.addEventListener('click', () => { App.closeOverlay(); ctx.toast('Connection registered. Test it, then introspect the schema to build the allow-list.', 'ok'); });
      }
    });
  }
})();
