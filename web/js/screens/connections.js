(function () {
  const { UI, esc } = App;

  const LABELS = ['public', 'internal', 'confidential', 'restricted'];
  const rank = (l) => LABELS.indexOf(l);
  const enc = encodeURIComponent;
  const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
  const ENGINE = { postgres: 'PostgreSQL', mysql: 'MySQL', opensearch: 'OpenSearch' };
  const isSql = (c) => c.engine !== 'opensearch';
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
        obj ? { id: 'read', label: 'First rows of ' + obj, q: 'SELECT *\nFROM ' + obj + '\nLIMIT ' + c.rowLimit + ';' } : null,
        obj ? { id: 'update', label: 'UPDATE (write)', q: 'UPDATE ' + obj + '\nSET ' + col + ' = ' + col + ';' } : null,
        obj ? { id: 'ddl', label: 'DROP TABLE (DDL)', q: 'DROP TABLE ' + obj + ';' } : null,
        outside[0] ? { id: 'denied', label: 'Table outside the allow-list', q: 'SELECT * FROM ' + outside[0].name + ' LIMIT 10;' } : null
      ].filter(Boolean);
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
    id: 'connections', title: 'Connections', live: true, summary: 'Database and search connections, schema allow-lists, sync status, data browser', section: 'admin',
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
      { title: 'Three engines', tone: 'info', text: 'Register offers PostgreSQL, MySQL and OpenSearch, with a sealed account or OpenBao dynamic credentials.', apply(ctx) { ctx.state.register = true; ctx.rerender(); } }
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
        App.get('/api/admin/connections').then((c) => { st.conns = c; st.loaded = true; st.loadError = null; }).catch((err) => { st.loadError = err; }).finally(() => { st.loading = false; later(); });
      };
      if (!st.loaded && !st.loadError) load();
      const act = async (fn, okMsg) => { try { const r = await fn(); if (okMsg) toast(okMsg, 'ok', 5000); load(); return r || true; } catch (err) { App.fail(err); return null; } };

      if (st.register) { st.register = false; setTimeout(() => openRegister(), 30); }
      if (st.loadError || !st.loaded) {
        root.innerHTML = '<div class="page">' + UI.pagehead('Connections', 'Database and search connections', UI.btn('Register', { attrs: 'data-register' }))
          + (st.loadError ? UI.problem('Connections could not be loaded', st.loadError.message, st.loadError.problem && st.loadError.problem.trace_id) + '<div>' + UI.btn('Try again', { attrs: 'data-reload' }) + '</div>' : UI.notice('Loading…', 'info')) + '</div>';
        ctx.on('click', '[data-reload]', () => { st.loadError = null; ctx.rerender(); });
        ctx.on('click', '[data-register]', () => openRegister());
        return;
      }

      const conns = st.conns;
      if (!conns.find((c) => c.id === st.conn)) st.conn = conns[0] ? conns[0].id : null;
      const conn = cur(st);
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
        + '<div class="vstack grow" style="gap:10px"><div class="hstack wrap"><div class="eyebrow">Query</div><span class="muted" style="font-size:12px">' + (isSql(conn) ? (conn.engine === 'mysql' ? 'MySQL SQL, one statement' : 'SQL, one statement') : 'POST /index/_search or _count, then a JSON body') + '</span><span class="right hstack gap6 wrap">' + exs.map((x) => UI.chip(esc(x.label), x.q === sql, 'data-example="' + x.id + '"')).join('') + '</span></div>'
        + (st.editing ? '<textarea class="textarea mono" data-sqledit style="min-height:126px;white-space:pre">' + esc(sql) + '</textarea>' : '<div data-code style="cursor:text" title="Click to edit">' + UI.code(sql || (isSql(conn) ? '-- write a query' : '# write a request'), isSql(conn) ? 'sql' : 'json') + '</div>')
        + '<div class="hstack wrap">' + UI.btn('Run query', { kind: 'primary', icon: 'play', attrs: 'data-run', disabled: !!st.running }) + UI.btn('Export', { icon: 'download', attrs: 'data-export' + (r && r.ok ? '' : ' disabled') }) + (st.editing ? UI.btn('Done editing', { kind: 'ghost', attrs: 'data-doneedit' }) : UI.btn('Edit', { kind: 'ghost', attrs: 'data-editsql' })) + '<span class="muted" style="font-size:12px">Row limit ' + conn.rowLimit + ', timeout ' + conn.timeoutS + ' s, results labelled ' + esc(conn.label) + '</span></div>'
        + resultHtml + '</div></div>');

      const settings = () => '<div class="panel"><div class="formgrid" style="--cols:3">'
        + UI.field('Type', UI.select([{ value: 'postgres', label: 'PostgreSQL' }, { value: 'mysql', label: 'MySQL' }, { value: 'opensearch', label: 'OpenSearch' }], conn.engine, 'disabled'), 'Fixed after registration')
        + UI.field('Endpoint', UI.input(conn.endpoint, { attrs: 'data-setting="endpoint"' }))
        + (isSql(conn) ? UI.field('Database', UI.input(conn.database || '', { attrs: 'data-setting="database"' })) : '')
        + UI.field('Network zone', UI.select(['data', 'core', 'gpu', 'edge'].concat(['data', 'core', 'gpu', 'edge'].indexOf(conn.zone) < 0 ? [conn.zone] : []), conn.zone, 'data-setting="zone"'))
        + (conn.credentialSource === 'openbao'
          ? UI.field('Credential', UI.input('OpenBao role ' + (conn.baoRole || '') + (conn.lease ? ', account ' + conn.lease.username + ' until ' + when(conn.lease.expiresAt) : ''), { readonly: true, attrs: 'class="input mono"' }), 'Short-lived accounts from the OpenBao database engine, renewed while in use and revoked when dropped. Switch to a sealed account with Rotate credential.')
          : UI.field('Credential', UI.input(conn.hasCredential ? (conn.account || 'set') + ' (sealed)' : 'none', { readonly: true, attrs: 'class="input mono"' }), 'Sealed with the tenant key and never shown again. Replace it with Rotate credential.'))
        + UI.field('Label ceiling', UI.select(LABELS, conn.label, 'data-setting="label"'), 'Results carry this label. Conversations above it cannot use the connection.')
        + UI.field('Allowed operations', UI.select([{ value: 'read', label: 'Read only (default)' }, { value: 'write', label: 'Read and write, separate account' }], conn.ops, 'data-setting="ops"'))
        + UI.field('Row limit', UI.input(String(conn.rowLimit), { type: 'number', attrs: 'data-setting="rowLimit"' }))
        + UI.field('Statement timeout, s', UI.input(String(conn.timeoutS), { type: 'number', attrs: 'data-setting="timeoutS"' }))
        + UI.field('TLS', UI.toggle('Verify the server certificate', conn.tls, 'data-setting-tls'))
        + UI.field('PII masking', UI.toggle('Mask PII-classified columns in every result', true, 'data-manual data-mask'))
        + '</div><div class="hstack">' + UI.btn('Save settings', { kind: 'primary', attrs: 'data-save' }) + UI.btn('Rotate credential now', { attrs: 'data-rotate' }) + UI.btn('Remove connection', { kind: 'danger', attrs: 'data-remove' }) + '<span class="muted right" style="font-size:12px">Version ' + conn.version + '</span></div></div>';

      const allow = () => {
        const on = (name, def) => (st.allow[conn.id + '|' + name] != null ? st.allow[conn.id + '|' + name] : def);
        const extra = conn.allowList.filter((a) => !conn.schema.some((o) => o.name === a));
        const rows = conn.schema.map((t) => ({ name: t.name, shape: t.columns.length + ' columns' + (t.kind ? ', ' + t.kind : ''), pii: t.columns.some((c) => c.pii), def: t.allowed })).concat(extra.map((a) => ({ name: a, shape: isSql(conn) ? 'not introspected' : 'index pattern', pii: false, def: true, pattern: true })));
        return '<div class="vstack" style="gap:10px">' + UI.notice('Only allow-listed objects appear in the introspected schema the model sees. Everything else is refused before the query is sent.', 'info')
          + UI.table(['', 'Object', 'Shape', 'Classification', 'Queries'], rows.map((t) => { const v = on(t.name, t.def); return { cells: [UI.check('', v, 'data-allowobj="' + esc(t.name) + '"'), '<span class="mono">' + esc(t.name) + '</span>', esc(t.shape), t.pii ? UI.pill('PII masked', 'warn') : t.pattern ? UI.pill('pattern') : UI.pill('clean', 'ok'), v ? UI.pill('allowed', 'ok') : UI.pill('refused', 'danger')] }; }), { clickable: false, minWidth: '0', emptyTitle: 'No schema yet', emptyText: 'Refresh schema to introspect the objects the account can read.' })
          + (conn.engine === 'opensearch' ? UI.field('Add an index pattern', UI.input('', { placeholder: 'logs-*', attrs: 'data-newpattern' })) : '')
          + UI.field('Extra PII columns', UI.input(conn.piiColumns.join(', '), { placeholder: 'schema.table.column, …', attrs: 'data-pii' }), 'Columns named like emails, IBANs, phones or national identifiers are masked already; list any others here.')
          + '<div class="hstack">' + UI.btn('Save allow-list', { kind: 'primary', attrs: 'data-saveallow' }) + '<span class="muted" style="font-size:12px">' + (conn.schemaAt ? 'Schema introspected ' + esc(when(conn.schemaAt)) + '. Refresh schema after a migration.' : 'Schema not introspected yet.') + '</span></div></div>';
      };

      const sync = () => '<div class="vstack" style="gap:10px">' + UI.table(['Target', 'Source object', 'Mode', 'Last sync', 'Volume', 'Status'], conn.syncs.map((s) => ['<a href="#" data-gokb="' + esc(s.kbId) + '">' + esc(s.kb) + '</a>', '<span class="mono">' + esc(s.object) + '</span>', 'Watermark, incremental', esc(when(s.lastSyncAt) || 'not yet'), s.docs + ' document' + (s.docs === 1 ? '' : 's'), UI.pill(s.state === 'idle' ? (s.lastSyncAt ? 'synced' : 'queued') : s.state)]), { clickable: false, minWidth: '0', emptyTitle: 'Nothing syncs from this connection', emptyText: 'Use as knowledge source to add a table or view to a knowledge base.' })
        + '<div class="hstack">' + UI.btn('Sync now', { attrs: 'data-syncnow' + (conn.syncs.length ? '' : ' disabled') }) + '<span class="muted" style="font-size:12px">Each row becomes a document; the chunks carry the connection\'s label, so retrieval respects it.</span></div></div>';

      root.innerHTML = '<style>'
        + '#main > .page > *{flex-shrink:0}'
        + '#main .conn-left{width:300px}'
        + '#main .conn-tree{display:flex;flex-direction:column;gap:2px;margin-bottom:6px}'
        + '#main .conn-obj{display:flex;align-items:center;gap:4px;border:0;background:transparent;padding:4px 4px;border-radius:4px;cursor:pointer;font-weight:500;color:var(--fg);text-align:left;font-family:inherit}#main .conn-obj:hover{background:var(--sel)}'
        + '#main .conn-col{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:2px 4px 2px 22px;color:var(--fg2)}'
        + '#main .conn-list{display:flex;flex-direction:column;gap:2px}'
        + '</style>'
        + '<div class="leftpane conn-left"><div class="hstack"><div class="eyebrow grow">Connections</div>' + UI.btn('Register', { size: 'sm', attrs: 'data-register' }) + '</div>'
        + '<div class="conn-list">' + conns.map((c) => UI.listItem(esc(c.name), esc(ENGINE[c.engine] || c.engine) + (c.zone ? ', zone ' + esc(c.zone) : ''), { active: conn && c.id === conn.id, attrs: 'data-conn="' + esc(c.id) + '"', right: UI.label(c.label, { sm: true }) })).join('') + (conns.length ? '' : '<div class="muted" style="font-size:12px">No connections yet.</div>') + '</div>'
        + '<div class="divider"></div><div class="muted" style="font-size:12px">PostgreSQL stays the system of record. MySQL and MongoDB connections arrive with a later import bundle.</div></div>'
        + '<div class="page">'
        + (st.demoNote ? UI.notice(esc(st.demoNote), 'info', UI.btn('Dismiss', { kind: 'ghost', size: 'sm', attrs: 'data-dismissnote' })) : '')
        + (!conn ? UI.pagehead('Connections', 'Database and search connections for the data browser and knowledge sources', '') + UI.empty('No connections yet', 'Register a PostgreSQL database or an OpenSearch cluster with a read-only account, then introspect its schema and allow the objects the model may read.', UI.btn('Register a connection', { kind: 'primary', attrs: 'data-register' }))
          : UI.pagehead(esc(conn.name), esc(conn.endpoint) + (conn.database ? '/' + esc(conn.database) : '') + (conn.credentialSource === 'openbao' ? ', OpenBao role ' + esc(conn.baoRole || '') : ', account ' + esc(conn.account || 'not set')) + ' ' + UI.pill(conn.health, HEALTH[conn.health]), UI.btn('Test connection', { attrs: 'data-test' }) + UI.btn('Refresh schema', { icon: 'refresh', attrs: 'data-refresh' }) + (canKb && conn.engine === 'postgres' ? UI.btn('Use as knowledge source', { kind: 'primary', attrs: 'data-usekb' }) : ''))
          + (conn.health === 'degraded' || conn.health === 'unreachable' ? UI.notice(esc(conn.healthDetail || (conn.health === 'unreachable' ? 'The last test could not reach the server.' : 'The last test reported a problem.')) + (conn.checkedAt ? ' <span class="muted">Checked ' + esc(when(conn.checkedAt)) + '.</span>' : ''), conn.health === 'unreachable' ? 'danger' : 'warn', App.canOpen('zones') ? '<a href="#" data-gozones>Zones</a>' : '') : '')
          + UI.notice('Read-only is enforced by the database account and a read-only transaction. The query parser is advisory.', 'ok')
          + UI.tabs([{ id: 'settings', label: 'Settings' }, { id: 'allow', label: 'Schema allow-list' }, { id: 'sync', label: 'Sync', count: conn.syncs.length }, { id: 'browser', label: 'Browser' }], st.tab)
          + (st.tab === 'settings' ? settings() : st.tab === 'allow' ? allow() : st.tab === 'sync' ? sync() : browser()))
        + '<div style="margin-top:auto"><div class="eyebrow" style="margin-bottom:8px">States to design from this page</div>' + UI.states(this.states) + '</div></div>';

      // ---- events ----
      ctx.on('click', '[data-register]', () => openRegister());
      ctx.on('click', '[data-conn]', (e, t) => { st.conn = t.dataset.conn; st.editing = false; ctx.rerender(); });
      ctx.on('click', '[data-dismissnote]', () => { st.demoNote = null; ctx.rerender(); });
      ctx.on('click', '.state-card', (e, t) => ctx.app.applyState(+t.dataset.state));
      if (!conn) return;
      ctx.on('click', '[data-tab]', (e, t) => { st.tab = t.dataset.tab; ctx.rerender(); });
      ctx.on('click', '[data-obj]', (e, t) => { st.treeOpen = t.dataset.obj; st.sqlBy[conn.id] = isSql(conn) ? 'SELECT *\nFROM ' + t.dataset.obj + '\nLIMIT ' + conn.rowLimit + ';' : 'POST /' + t.dataset.obj + '/_search\n{\n  "size": ' + conn.rowLimit + ',\n  "query": { "match_all": {} }\n}'; delete st.results[conn.id]; st.editing = false; st.tab = 'browser'; ctx.rerender(); });
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
      ctx.on('click', '[data-aggregate]', () => { const o = allowedObjs.find((x) => (r && r.query || '').indexOf(x.name) >= 0) || allowedObjs[0]; if (!o) return; st.sqlBy[conn.id] = 'SELECT count(*) AS row_count\nFROM ' + o.name + ';'; delete st.results[conn.id]; st.editing = true; ctx.rerender(); toast('Edit the aggregate (group by a column that matters), then run it.'); });
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
        ctx.modal({ title: 'Use as knowledge source', body: '<p style="margin:0" class="fg2">Adds an allow-listed view or table to a knowledge base. Each row becomes a document; chunks carry at least the connection label (' + esc(conn.label) + ').</p>' + UI.field('Knowledge base', UI.select(bases.map((k) => ({ value: k.id, label: k.name + ' (' + k.label + ')' })), bases[0].id, 'data-kbsel')) + UI.field('View or table', UI.select(allowedObjs.map((o) => o.name), allowedObjs[0].name, 'data-objsel')) + UI.field('Sync', UI.select([{ value: '15m', label: 'Watermark on updated_at, every 15 min (default)' }, { value: 'hourly', label: 'hourly' }, { value: 'daily', label: 'daily' }, { value: 'manual', label: 'manual' }], '15m', 'data-sched')) + '<div data-err></div>',
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
        const tls = ctx.$('[data-setting-tls]'); if (tls) body.tls = tls.classList.contains('on');
        if (body.ops === 'read') delete body.ops;
        act(() => App.patch('/api/admin/connections/' + enc(conn.id), body)).then((o) => { if (o && o.version) toast('Settings saved as version ' + o.version + '. Audit entry written.', 'ok'); });
      });
      ctx.on('click', '[data-rotate]', () => {
        const sqlConn = isSql(conn);
        ctx.modal({ title: 'Rotate credential for ' + esc(conn.name), body: (sqlConn ? UI.field('Source', UI.select([{ value: 'static', label: 'Sealed account' }, { value: 'openbao', label: 'OpenBao dynamic credentials' }], conn.credentialSource || 'static', 'data-src')) : '') + '<div data-staticwrap>' + UI.field('Account', UI.input(conn.account || '', { attrs: 'data-user autocomplete="off"' }), 'A read-only account. An account with write grants shows as degraded on the next test.') + UI.field('Password', '<input type="password" class="input" data-pass autocomplete="new-password">', 'Sealed with the tenant key; it is never shown again.') + '</div><div data-baowrap>' + UI.field('OpenBao role', UI.input(conn.baoRole || '', { attrs: 'data-role autocomplete="off" placeholder="ledger-readonly"' }), 'A database-engine role that grants SELECT only. Accounts are issued per instance, renewed while used and revoked when dropped.') + '</div><div data-err></div>',
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
              const u = m.querySelector('[data-user]').value.trim(); if (!u) { toast('Give the account name.'); return; }
              try { await App.api('PUT', '/api/admin/connections/' + enc(conn.id) + '/credential', { username: u, password: m.querySelector('[data-pass]').value }); App.closeOverlay(); toast('Credential replaced and sealed. Test the connection to check it.', 'ok'); load(); }
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
    App.modal({
      title: 'Register a connection',
      body: UI.notice('PostgreSQL, MySQL and OpenSearch are available. MongoDB is not in this release. The zone must be one defined under Zones, with a ceiling at or above the label.', 'info')
        + '<div class="formgrid">' + UI.field('Engine', UI.select([{ value: 'postgres', label: 'PostgreSQL' }, { value: 'mysql', label: 'MySQL' }, { value: 'opensearch', label: 'OpenSearch' }, { value: 'mongodb', label: 'MongoDB (not available)' }], 'postgres', 'data-engine'))
        + UI.field('Name', UI.input('', { placeholder: 'for example sales-ro', attrs: 'data-name' })) + UI.field('Endpoint', UI.input('', { placeholder: 'host:port', attrs: 'data-endpoint' })) + '<div data-dbwrap>' + UI.field('Database', UI.input('', { placeholder: 'ledger', attrs: 'data-db' })) + '</div>' + UI.field('Network zone', UI.select(ZONES, 'data', 'data-zone'))
        + UI.field('Label ceiling', UI.select(LABELS, 'internal', 'data-label')) + '<div data-srcwrap>' + UI.field('Credentials', UI.select([{ value: 'static', label: 'Sealed account' }, { value: 'openbao', label: 'OpenBao dynamic credentials' }], 'static', 'data-src')) + '</div>'
        + '<div data-staticwrap>' + UI.field('Read-only account', UI.input('', { attrs: 'data-user autocomplete="off"' })) + UI.field('Password', '<input type="password" class="input" data-pass autocomplete="new-password">', 'Sealed with the tenant key; never shown again.') + '</div>'
        + '<div data-baowrap>' + UI.field('OpenBao role', UI.input('', { attrs: 'data-role autocomplete="off" placeholder="ledger-readonly"' }), 'GET database/creds/&lt;role&gt; issues a short-lived read-only account.') + '</div>'
        + UI.field('Row limit', UI.input('500', { type: 'number', attrs: 'data-rows' })) + UI.field('Statement timeout, s', UI.input('10', { type: 'number', attrs: 'data-timeout' })) + '</div>'
        + UI.check('Use TLS and verify the server certificate', false, 'data-tls') + '<div data-enginewarn></div><div data-err></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Register', { kind: 'primary', attrs: 'data-doreg' }),
      onMount(m) {
        const q = (s) => m.querySelector(s);
        const sel = q('[data-engine]'); const warn = q('[data-enginewarn]'); const btn = q('[data-doreg]');
        const src = q('[data-src]');
        const check = () => { const off = sel.value === 'mongodb'; const sql = sel.value === 'postgres' || sel.value === 'mysql'; warn.innerHTML = off ? UI.notice('That engine is not installed on this platform. Register offers PostgreSQL, MySQL and OpenSearch.', 'warn') : ''; btn.disabled = off; q('[data-dbwrap]').hidden = !sql; q('[data-srcwrap]').hidden = !sql; if (!sql) src.value = 'static'; const bao = src.value === 'openbao'; q('[data-staticwrap]').hidden = bao; q('[data-baowrap]').hidden = !bao; q('[data-endpoint]').placeholder = sel.value === 'opensearch' ? 'https://host:9200' : sel.value === 'mysql' ? 'host:3306' : 'host:5432'; };
        sel.addEventListener('change', check); src.addEventListener('change', check); check();
        btn.addEventListener('click', async () => {
          const tlsBox = q('[data-tls]'); const tlsIn = tlsBox && (tlsBox.matches('input') ? tlsBox : tlsBox.querySelector('input'));
          const body = { name: q('[data-name]').value.trim(), engine: sel.value, endpoint: q('[data-endpoint]').value.trim(), database: sel.value !== 'opensearch' ? (q('[data-db]').value.trim() || null) : null, zone: q('[data-zone]').value, label: q('[data-label]').value, rowLimit: Math.round(+q('[data-rows]').value || 500), timeoutS: Math.round(+q('[data-timeout]').value || 10), tls: !!(tlsIn && tlsIn.checked), username: src.value === 'openbao' ? null : (q('[data-user]').value.trim() || null), password: src.value === 'openbao' ? null : (q('[data-pass]').value || null), baoRole: src.value === 'openbao' ? (q('[data-role]').value.trim() || null) : null };
          if (src.value === 'openbao' && !body.baoRole) { App.toast('Give the OpenBao role.'); return; }
          if (!body.name || !body.endpoint) { App.toast('Give the connection a name and an endpoint.'); return; }
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
