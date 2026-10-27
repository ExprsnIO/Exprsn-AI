/*
 * 1.8.0, Sprint 45 (B-125, B-126): the Connections screen's Saved queries tab (per data connection: editor,
 * parameters, test run, versions) and its REST connections (register, settings, endpoints with a test call showing
 * the mapped rows). connections.js calls these; every control goes to /api/admin/connection-queries and
 * /api/admin/rest-connections.
 * 1.9.0: API connections speak REST, GraphQL (a query document with variables, the schema helper's root fields) or
 * SOAP (the WSDL's operations, their input fields as argument rows, refresh and upload of the WSDL).
 * 1.9.0, second round: OData v4 (an entity set from $metadata, $select and $expand pickers, a checked $filter with
 * {param} placeholders, $orderby, $search) and OpenAPI import on REST connections (GET operations become endpoints).
 */
(function () {
  const { UI, esc } = App;
  const enc = encodeURIComponent;
  const LABELS = ['public', 'internal', 'confidential', 'restricted'];
  const ZONES = ['data', 'app', 'sandbox', 'inference', 'directory', 'training', 'edge'];
  const HEALTH = { healthy: 'ok', degraded: 'warn', unreachable: 'danger', unknown: '' };
  const AUTH = [{ value: 'none', label: 'None' }, { value: 'basic', label: 'Basic' }, { value: 'bearer', label: 'Bearer token' }, { value: 'api-key-header', label: 'API key in a header' }, { value: 'api-key-query', label: 'API key in the query' }, { value: 'oauth2-client', label: 'OAuth2 client credentials' }];
  const PAGING = ['none', 'page', 'offset', 'cursor', 'link'];
  const PROTOCOLS = [{ value: 'rest', label: 'REST (GET, JSON)' }, { value: 'graphql', label: 'GraphQL (queries only)' }, { value: 'soap', label: 'SOAP (WSDL 1.1)' }, { value: 'odata', label: 'OData v4 (entity sets)' }];
  const PROTO_NAME = { rest: 'REST', graphql: 'GraphQL', soap: 'SOAP', odata: 'OData' };
  /** The entity sets and singletons of an OData connection's $metadata. */
  const odataSets = (c) => ((c.odata && c.odata.sets) || []);
  const findSet = (c, name) => odataSets(c).find((x) => x.name === name) || null;
  /** The operations of a SOAP connection, as `name|port` choices. */
  const soapOps = (c) => ((c.soap && c.soap.operations) || []);
  const opKey = (o) => o.name + '|' + o.port;
  const findOp = (c, soap) => (soap ? soapOps(c).find((o) => o.name === soap.operation && (!soap.port || o.port === soap.port)) : null) || null;
  /** A starting definition for a new endpoint in the connection's protocol. */
  function blankDef(c) {
    if (c.protocol === 'odata') {
      const first = odataSets(c)[0];
      return { path: '', params: [], query: {}, paging: first && first.kind === 'set' ? { kind: 'link', maxPages: 20 } : { kind: 'none' }, mapping: { items: '', fields: [] }, odata: { entitySet: first ? first.name : '', select: [], expand: [], count: false } };
    }
    if (c.protocol === 'graphql') return { path: '', params: [], query: {}, paging: { kind: 'none' }, mapping: { items: '/data', fields: [] }, graphql: { query: 'query {\n  \n}', variables: {} } };
    if (c.protocol === 'soap') {
      const ports = (c.soap && c.soap.ports) || [];
      const first = soapOps(c).find((o) => !o.writeLike && (ports.find((p) => p.name === o.port) || {}).usable) || soapOps(c)[0];
      return { path: '', params: [], query: {}, paging: { kind: 'none' }, mapping: { items: first ? '/' + (first.output || first.name + 'Response') : '', fields: [] }, soap: { operation: first ? first.name : '', port: first ? first.port : undefined, args: {}, confirmRead: false } };
    }
    return { path: '/', params: [], query: {}, paging: { kind: 'none' }, mapping: { items: '', fields: [] } };
  }
  /** A query skeleton for one root field: its arguments as variables, filled from parameters of the same name. */
  function fieldSkeleton(f) {
    const args = f.args || [];
    const vars = args.map((a) => '$' + a.name + ': ' + a.type).join(', ');
    return { query: 'query' + (args.length ? ' (' + vars + ')' : '') + ' {\n  ' + f.name + (args.length ? '(' + args.map((a) => a.name + ': $' + a.name).join(', ') + ')' : '') + ' {\n    \n  }\n}', variables: Object.fromEntries(args.map((a) => [a.name, '{' + a.name.replace(/[^a-z0-9_]/gi, '_').toLowerCase() + '}'])) };
  }
  const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
  const cell = (v) => (v == null ? '<span class="muted">null</span>' : esc(typeof v === 'object' ? JSON.stringify(v) : String(v)));
  const pretty = (v) => JSON.stringify(v, null, 2);
  const errBox = (err) => UI.notice('<b>' + esc((err.problem && err.problem.title) || 'Refused') + '.</b> ' + esc(err.message), 'danger');
  const parseJson = (text, what) => { try { return text.trim() ? JSON.parse(text) : null; } catch (e) { throw new Error(what + ' is not JSON: ' + e.message); } };
  const STYLE = '<style>#main .cs-wrap{display:flex;flex-direction:column;gap:10px;min-width:0}#main .cs-wrap textarea{width:100%;box-sizing:border-box}#main .cs-res{overflow-x:auto;max-width:100%}#main .cs-fs{border:0;padding:0;margin:0 0 8px;min-width:0}#main .cs-fs legend{padding:0;margin-bottom:4px}</style>';

  /** The rows of a read result (columns with types, rows as objects) as a table. */
  function rowsTable(out) {
    const cols = (out.columns || []).map((c) => c.name);
    return '<div class="cs-res">' + UI.table(cols.length ? cols : ['(no columns)'], (out.rows || []).map((r) => cols.map((c) => cell(r[c]))), { clickable: false, minWidth: '0', emptyTitle: 'No rows', emptyText: 'The call ran and returned nothing.' }) + '</div>'
      + '<span class="muted" style="font-size:12px">' + (out.rows || []).length + ' row' + ((out.rows || []).length === 1 ? '' : 's') + (out.truncated ? ' (more follow)' : '') + (out.pages != null ? ', ' + out.pages + ' page' + (out.pages === 1 ? '' : 's') : '') + (out.ms != null ? ', ' + out.ms + ' ms' : '') + (out.label ? ', labelled ' + esc(out.label) : '') + '.' + (out.masked && out.masked.length ? ' Masked: ' + out.masked.map(esc).join(', ') + '.' : '') + '</span>'
      + (out.untrusted ? UI.notice('The untrusted-content checkpoint found instructions in this answer' + (out.untrusted.rule ? ' (' + esc(out.untrusted.rule) + ')' : '') + '. A model reads it with a warning.', 'warn') : '');
  }

  /** One input per parameter, filled from what the user typed last. */
  function paramInputs(params, values, attr) {
    if (!params || !params.length) return '<div class="muted" style="font-size:12px">No parameters.</div>';
    return '<div class="formgrid" style="--cols:3">' + params.map((p) => UI.field(p.title || p.name, UI.input(values[p.name] != null ? String(values[p.name]) : p.default != null ? String(p.default) : '', { placeholder: p.type + (p.required ? ', required' : ''), attrs: attr + '="' + esc(p.name) + '"' }), esc(p.type + (p.allowed ? ': ' + p.allowed.join(', ') : '') + (p.type === 'list' ? ', comma separated' : '')))).join('') + '</div>';
  }
  function readParams(root, attr, params) {
    const out = {};
    (params || []).forEach((p) => {
      const i = root.querySelector('[' + attr + '="' + p.name + '"]');
      const v = i ? i.value.trim() : '';
      if (v === '') return;
      out[p.name] = p.type === 'number' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : p.type === 'boolean' ? v === 'true' : v;
    });
    return out;
  }

  // ---------- saved queries ----------

  const QUERY_EXAMPLE = { postgres: 'SELECT id, name\nFROM public.customers\nWHERE tier = :tier\nORDER BY name', mysql: 'SELECT id, name\nFROM customers\nWHERE tier = :tier\nORDER BY name', opensearch: 'POST /logs-*/_search\n{ "query": { "term": { "level": { "$param": "level" } } } }', mongodb: '{ "find": "orders", "filter": { "status": { "$param": "status" } } }' };

  function queriesTab(ctx, conn, st, done) {
    st.queries = st.queries || {};
    st.qsel = st.qsel || {};
    st.qparams = st.qparams || {};
    const list = st.queries[conn.id];
    if (!list) {
      if (!st.qloading) {
        st.qloading = true;
        App.get('/api/admin/connections/' + enc(conn.id) + '/queries').then((q) => { st.queries[conn.id] = q; }).catch((err) => { st.queries[conn.id] = { error: err }; }).finally(() => { st.qloading = false; done(); });
      }
      return { html: UI.notice('Loading saved queries…', 'info'), bind() {} };
    }
    if (list.error) return { html: UI.problem('Saved queries could not be loaded', list.error.message), bind() {} };
    const q = list.find((x) => x.id === st.qsel[conn.id]) || null;
    const reload = () => { delete st.queries[conn.id]; done(); };
    const res = st.qresult && st.qresult.id === (q && q.id) ? st.qresult : null;
    let html = STYLE + '<div class="cs-wrap">' + UI.notice('A saved query is classified when it is saved and must read allow-listed objects. Parameters are bound by the driver, never pasted into the text: write <span class="mono">:name</span> in SQL, or <span class="mono">{"$param": "name"}</span> in a JSON query. Runs go through masking and the db-query guardrail, and are audited.', 'info')
      + '<div class="hstack wrap"><div class="eyebrow grow">Saved queries on ' + esc(conn.name) + '</div>' + UI.btn('New saved query', { kind: 'primary', size: 'sm', attrs: 'data-qnew' }) + '</div>'
      + UI.table(['Name', 'Label', 'Published', 'Kind', 'Lookups', 'Updated'], list.map((x) => ({ cells: ['<span class="mono">' + esc(x.name) + '</span>' + (x.title ? ' <span class="muted">' + esc(x.title) + '</span>' : ''), UI.label(x.label, { sm: true }), x.publishedVersion ? 'v' + x.publishedVersion + (x.dirty ? ' ' + UI.pill('draft changed', 'warn') : '') : UI.pill('draft'), x.write ? UI.pill('write query', 'danger') : UI.pill('read', 'ok'), x.lookups ? 'offered' : '', esc(when(x.updatedAt))], attrs: 'data-qrow="' + esc(x.id) + '"', selected: q && q.id === x.id })), { clickable: true, minWidth: '0', emptyTitle: 'No saved queries', emptyText: 'Save a parameterised query that tools, workflows, knowledge bases and app lookups can run.' });
    if (q) {
      const d = q.draft;
      const vals = st.qparams[q.id] || {};
      html += '<div class="panel"><div class="phead"><div class="eyebrow">Editor</div><span class="muted" style="font-size:12px">Draft revision ' + q.draftRev + (q.draftClassification ? ', classified ' + esc(q.draftClassification.kind) + ' of ' + esc((q.draftClassification.objects || []).join(', ') || 'nothing') : '') + '</span></div>'
        + '<div class="formgrid" style="--cols:3">' + UI.field('Title', UI.input(q.title || '', { attrs: 'data-qf="title"' })) + UI.field('Label', UI.select(LABELS, q.label, 'data-qf="label"'), 'At least the connection\'s label.') + UI.field('Row limit', UI.input(String(d.rowLimit), { type: 'number', attrs: 'data-qf="rowLimit"' })) + UI.field('Timeout, s', UI.input(String(d.timeoutS), { type: 'number', attrs: 'data-qf="timeoutS"' })) + UI.field('Default object', UI.input(d.object || '', { placeholder: 'index or collection', attrs: 'data-qf="object"' })) + UI.field('Description', UI.input(q.description || '', { attrs: 'data-qf="description"' })) + '</div>'
        + '<div class="hstack wrap">' + UI.check('Offer to app lookups', q.lookups, 'data-qf-lookups') + UI.check('Write query (saved and reviewed, never run here)', q.write, 'data-qf-write') + '</div>'
        + UI.field('Query', UI.textarea(d.text, { rows: 6, attrs: 'class="textarea mono" data-qf="text"' }))
        + UI.field('Parameters', UI.textarea(pretty(d.params), { rows: 5, attrs: 'class="textarea mono" data-qf="params"' }), 'A list of {"name", "type": string, number, boolean, date, list or identifier, "required", "default", "allowed", "min", "max"}. An identifier stands only for a name it lists.')
        + '<div data-qerr></div><div class="hstack wrap">' + UI.btn('Save draft', { kind: 'primary', attrs: 'data-qsave' }) + UI.btn('Publish', { attrs: 'data-qpublish' }) + UI.btn('Delete', { kind: 'danger', attrs: 'data-qdelete' }) + '</div></div>'
        + '<div class="panel"><div class="phead"><div class="eyebrow">Test run</div>' + UI.select([{ value: 'draft', label: 'Draft' }].concat((q.versions || []).map((v) => ({ value: String(v.version), label: 'Version ' + v.version + (v.state === 'published' ? ' (published)' : '') }))), st.qversion || 'draft', 'data-qversion aria-label="Version to test"') + '</div>'
        + paramInputs(d.params, vals, 'data-qp') + '<div class="hstack">' + UI.btn('Run test', { icon: 'play', attrs: 'data-qtest' }) + '</div>'
        + (res ? (res.error ? errBox(res.error) : rowsTable(res.out) + (res.out.classification ? '<span class="muted" style="font-size:12px">Classified ' + esc(res.out.classification.kind) + ': ' + esc((res.out.classification.objects || []).join(', ')) + '.</span>' : '')) : '') + '</div>'
        + '<div class="panel"><div class="eyebrow">Versions</div>' + UI.table(['Version', 'State', 'Note', 'Published'], (q.versions || []).map((v) => ['v' + v.version, UI.pill(v.state, v.state === 'published' ? 'ok' : ''), esc(v.note || ''), esc(when(v.publishedAt))]), { clickable: false, minWidth: '0', emptyTitle: 'Not published yet', emptyText: 'Runs use the published version; publish the draft when it is right.' }) + '</div>';
    }
    html += '</div>';
    return {
      html,
      bind() {
        ctx.on('click', '[data-qrow]', (e, t) => { st.qsel[conn.id] = t.dataset.qrow; st.qresult = null; done(); });
        ctx.on('click', '[data-qnew]', () => newQuery(ctx, conn, st, reload));
        if (!q) return;
        const form = () => {
          const v = (k) => { const i = ctx.$('[data-qf="' + k + '"]'); return i ? i.value : ''; };
          const lk = ctx.$('[data-qf-lookups]'); const wr = ctx.$('[data-qf-write]');
          return { rev: q.draftRev, title: v('title').trim() || null, description: v('description').trim() || null, label: v('label'), lookups: !!(lk && lk.checked), write: !!(wr && wr.checked), definition: { text: v('text'), object: v('object').trim() || null, params: parseJson(v('params'), 'Parameters') || [], rowLimit: Math.round(+v('rowLimit') || 500), timeoutS: Math.round(+v('timeoutS') || 10) } };
        };
        const showErr = (err) => { const b = ctx.$('[data-qerr]'); if (b) b.innerHTML = errBox(err); };
        ctx.on('click', '[data-qsave]', async () => { try { await App.put('/api/admin/connection-queries/' + enc(q.id), form()); ctx.toast('<span>Draft saved and classified. Audit entry written.</span>', 'ok'); reload(); } catch (err) { showErr(err); } });
        ctx.on('click', '[data-qpublish]', async () => {
          const ok = await ctx.confirm({ title: 'Publish ' + esc(q.name), tag: q.label, tone: 'info', body: '<p class="fg2" style="margin:0">The draft is classified again against the allow-list in force and becomes the next version. Tools, workflows, knowledge sources and lookups run the published version.</p>', ok: 'Publish' });
          if (!ok) return;
          try { const out = await App.post('/api/admin/connection-queries/' + enc(q.id) + '/publish', {}); ctx.toast('<span>Published as version ' + out.version + '.</span>', 'ok'); reload(); } catch (err) { showErr(err); }
        });
        ctx.on('click', '[data-qdelete]', async () => {
          const ok = await ctx.confirm({ title: 'Delete ' + esc(q.name), tag: 'destructive', tone: 'danger', body: '<p class="fg2" style="margin:0">The query and its versions are deleted. A knowledge source that reads it must go first.</p>', ok: 'Delete' });
          if (!ok) return;
          try { await App.del('/api/admin/connection-queries/' + enc(q.id)); st.qsel[conn.id] = null; ctx.toast('<span>' + esc(q.name) + ' deleted. Audit entry written.</span>', 'ok'); reload(); } catch (err) { App.fail(err); }
        });
        ctx.on('change', '[data-qversion]', (e, t) => { st.qversion = t.value; });
        ctx.on('click', '[data-qtest]', async () => {
          const params = readParams(ctx.$('#main') || document, 'data-qp', q.draft.params);
          st.qparams[q.id] = params;
          const v = st.qversion && st.qversion !== 'draft' ? Number(st.qversion) : 'draft';
          try { st.qresult = { id: q.id, out: await App.post('/api/admin/connection-queries/' + enc(q.id) + '/test', { version: v, params }) }; }
          catch (err) { st.qresult = { id: q.id, error: err }; }
          done();
        });
      }
    };
  }

  function newQuery(ctx, conn, st, reload) {
    ctx.modal({
      title: 'New saved query on ' + esc(conn.name),
      body: '<div class="formgrid">' + UI.field('Name', UI.input('', { placeholder: 'customers-by-tier', attrs: 'data-n' })) + UI.field('Label', UI.select(LABELS, conn.label, 'data-l')) + '</div>'
        + UI.field('Query', UI.textarea(QUERY_EXAMPLE[conn.engine] || '', { rows: 5, attrs: 'class="textarea mono" data-t' }))
        + UI.field('Parameters', UI.textarea(pretty([{ name: conn.engine === 'opensearch' ? 'level' : conn.engine === 'mongodb' ? 'status' : 'tier', type: 'string', required: true }]), { rows: 4, attrs: 'class="textarea mono" data-p' }))
        + '<div data-err></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save draft', { kind: 'primary', attrs: 'data-go' }),
      onMount(m) {
        m.querySelector('[data-go]').addEventListener('click', async () => {
          try {
            const body = { name: m.querySelector('[data-n]').value.trim(), label: m.querySelector('[data-l]').value, definition: { text: m.querySelector('[data-t]').value, params: parseJson(m.querySelector('[data-p]').value, 'Parameters') || [] } };
            const q = await App.post('/api/admin/connections/' + enc(conn.id) + '/queries', body);
            App.closeOverlay();
            st.qsel[conn.id] = q.id;
            ctx.toast('<span>Saved as a draft, classified ' + esc(q.draftClassification ? q.draftClassification.kind : 'read') + '. Test it, then publish.</span>', 'ok');
            reload();
          } catch (err) { m.querySelector('[data-err]').innerHTML = errBox(err); }
        });
      }
    });
  }

  // ---------- REST connections ----------

  function restPage(ctx, c, st, done) {
    st.esel = st.esel || {};
    st.eparams = st.eparams || {};
    const e = (c.endpoints || []).find((x) => x.name === st.esel[c.id]) || null;
    const res = st.eresult && st.eresult.conn === c.id ? st.eresult : null;
    const reload = () => { st.restLoaded = false; done(); };
    const draft = st.edraft && st.edraft.conn === c.id ? st.edraft : null;
    const def = draft ? draft.def : e ? Object.assign({ path: e.path, params: e.params, query: e.query, paging: e.paging, mapping: e.mapping }, e.graphql ? { graphql: e.graphql } : {}, e.soap ? { soap: e.soap } : {}, e.odata ? { odata: e.odata } : {}) : null;
    const auth = c.auth || { kind: 'none' };
    const proto = c.protocol || 'rest';
    const pagingKinds = proto === 'rest' ? PAGING : proto === 'odata' ? ['none', 'offset', 'link'] : PAGING.filter((k) => k !== 'link');
    const callOf = (x) => (proto === 'graphql' ? 'POST query' + (x.path ? ' ' + x.path : '') : proto === 'soap' ? 'SOAP ' + ((x.soap && x.soap.operation) || '') : proto === 'odata' ? 'GET ' + ((x.odata && x.odata.entitySet) || '') : 'GET ' + (x.path || '/'));
    const curSet = proto === 'odata' && def && def.odata ? findSet(c, def.odata.entitySet) : null;
    st.gschema = st.gschema || {};
    const gs = st.gschema[c.id] || null;
    const curOp = proto === 'soap' && def ? findOp(c, def.soap) : null;
    let html = STYLE + UI.pagehead(esc(c.name), '<span class="mono">' + esc(c.baseUrl) + '</span>, ' + PROTO_NAME[proto] + ', ' + esc((AUTH.find((a) => a.value === auth.kind) || {}).label || auth.kind) + ' ' + UI.pill(c.health, HEALTH[c.health]), UI.btn('Test connection', { attrs: 'data-rtest' }) + UI.btn('Remove', { kind: 'danger', attrs: 'data-rremove' }))
      + (c.health === 'unreachable' || c.health === 'degraded' ? UI.notice(esc(c.healthDetail || 'The last call failed.') + (c.checkedAt ? ' <span class="muted">Checked ' + esc(when(c.checkedAt)) + '.</span>' : ''), c.health === 'unreachable' ? 'danger' : 'warn') : '')
      + UI.notice('Requests go only to hosts on the tenant\'s list of allowed hosts, through the egress guard, capped at ' + Math.round(c.maxBytes / 1024) + ' KB and ' + c.timeoutMs + ' ms. Every answer passes the untrusted-content checkpoint.' + (proto === 'graphql' ? ' Only query operations are sent: mutations and subscriptions are refused.' : proto === 'soap' ? ' Calls go only to port addresses under the base URL; operations named like writes need your confirmation that they only read.' : proto === 'odata' ? ' Only entity sets are read (GET): actions and functions are never called; parameters become OData literals of the property\'s type.' : ''), 'ok')
      + (proto === 'odata' ? '<div class="panel"><div class="phead"><div class="eyebrow">$metadata</div><span class="muted" style="font-size:12px">' + (c.metadataUrl ? '<span class="mono">' + esc(c.metadataUrl) + '</span>' : '') + (c.metadataAt ? ', read ' + esc(when(c.metadataAt)) : '') + ', ' + odataSets(c).length + ' entity set' + (odataSets(c).length === 1 ? '' : 's') + '</span></div>'
        + UI.table(['Name', 'Kind', 'Type', 'Properties', 'Navigation'], odataSets(c).map((x) => ['<span class="mono">' + esc(x.name) + '</span>', esc(x.kind), '<span class="mono">' + esc(x.entityType) + '</span>', String(x.properties.length), String(x.navigation.length)]), { clickable: false, minWidth: '0', emptyTitle: 'No entity sets', emptyText: 'The metadata names none.' })
        + ((c.odata && c.odata.notes && c.odata.notes.length) ? UI.notice(c.odata.notes.map(esc).join(' '), 'warn') : '')
        + '<div class="hstack wrap">' + UI.btn('Read $metadata again', { icon: 'refresh', attrs: 'data-mrefresh' }) + '</div></div>' : '')
      + (proto === 'rest' ? '<div class="panel"><div class="phead"><div class="eyebrow">OpenAPI</div><span class="muted" style="font-size:12px">' + (c.openapi ? esc(c.openapi.title || 'Document') + (c.openapi.version ? ' ' + esc(c.openapi.version) : '') + ', OpenAPI ' + esc(c.openapi.specVersion) + ', ' + c.openapi.operations.filter((o) => o.importable).length + ' GET operation' + (c.openapi.operations.filter((o) => o.importable).length === 1 ? '' : 's') + ' to import' + (c.openapi.at ? ', read ' + esc(when(c.openapi.at)) : '') : 'Make endpoints from an OpenAPI 3 or Swagger 2.0 document: GET operations only.') + '</span></div>'
        + '<div class="hstack wrap">' + UI.btn('Import from OpenAPI', { icon: 'plus', attrs: 'data-oimport' }) + '</div></div>' : '')
      + (proto === 'soap' ? '<div class="panel"><div class="phead"><div class="eyebrow">WSDL</div><span class="muted" style="font-size:12px">' + (c.wsdlUrl ? '<span class="mono">' + esc(c.wsdlUrl) + '</span>' : 'Uploaded') + (c.wsdlAt ? ', read ' + esc(when(c.wsdlAt)) : '') + ', ' + soapOps(c).length + ' operation' + (soapOps(c).length === 1 ? '' : 's') + '</span></div>'
        + UI.table(['Port', 'SOAP', 'Address', 'Used'], ((c.soap && c.soap.ports) || []).map((p) => [esc(p.name), esc(p.soapVersion), '<span class="mono">' + esc(p.address) + '</span>', p.usable ? UI.pill('under the base URL', 'ok') : UI.pill('outside: not called', 'warn')]), { clickable: false, minWidth: '0', emptyTitle: 'No ports', emptyText: 'The WSDL has no SOAP port.' })
        + ((c.soap && c.soap.notes && c.soap.notes.length) ? UI.notice(c.soap.notes.map(esc).join(' '), 'warn') : '')
        + '<div class="hstack wrap">' + (c.wsdlUrl ? UI.btn('Fetch the WSDL again', { icon: 'refresh', attrs: 'data-wrefresh' }) : '') + UI.btn('Upload a WSDL', { attrs: 'data-wupload' }) + '<a class="btn" href="/api/admin/rest-connections/' + enc(c.id) + '/wsdl">Download the WSDL</a></div></div>' : '')
      + '<div class="cs-wrap"><div class="panel"><div class="eyebrow">Settings</div><div class="formgrid" style="--cols:3">'
      + UI.field('Base URL', UI.input(c.baseUrl, { attrs: 'data-rs="baseUrl"' })) + UI.field('Label', UI.select(LABELS, c.label, 'data-rs="label"')) + UI.field('Network zone', UI.select(ZONES.indexOf(c.zone) < 0 ? ZONES.concat([c.zone]) : ZONES, c.zone, 'data-rs="zone"'))
      + UI.field('Timeout, ms', UI.input(String(c.timeoutMs), { type: 'number', attrs: 'data-rs="timeoutMs"' })) + UI.field('Size cap, bytes', UI.input(String(c.maxBytes), { type: 'number', attrs: 'data-rs="maxBytes"' })) + UI.field('Secret', UI.input(auth.hasSecret ? (auth.secretFromVault ? 'from the vault' : 'sealed') : 'none', { readonly: true }), 'Never shown again. Change authentication to replace it.') + '</div>'
      + UI.field('Default headers', UI.textarea(pretty(c.headers || {}), { rows: 3, attrs: 'class="textarea mono" data-rs="headers"' }), 'No credential literals: a credential header takes a vault reference such as Bearer vault:apis/x#token.')
      + '<div data-rerr></div><div class="hstack wrap">' + UI.btn('Save settings', { kind: 'primary', attrs: 'data-rsave' }) + UI.btn('Change authentication', { attrs: 'data-rauth' }) + '<span class="muted right" style="font-size:12px">Version ' + c.version + '</span></div></div>'
      + '<div class="hstack wrap"><div class="eyebrow grow">Endpoints</div>' + UI.btn('New endpoint', { kind: 'primary', size: 'sm', attrs: 'data-enew' }) + '</div>'
      + UI.table(['Name', proto === 'rest' ? 'Path' : 'Call', 'Paging', 'Fields', 'Lookups'], (c.endpoints || []).map((x) => ({ cells: ['<span class="mono">' + esc(x.name) + '</span>', '<span class="mono">' + esc(callOf(x)) + '</span>', esc(x.paging.kind), String(x.mapping.fields.length || 'all'), x.lookups ? 'offered' : ''], attrs: 'data-erow="' + esc(x.name) + '"', selected: e && e.name === x.name })), { clickable: true, minWidth: '0', emptyTitle: 'No endpoints', emptyText: 'Name a GET resource with its path, paging and the fields to map.' });
    if (def) {
      const vals = st.eparams[c.id] || {};
      html += '<div class="panel"><div class="phead"><div class="eyebrow">' + (e && !draft ? 'Endpoint ' + esc(e.name) : 'New endpoint') + '</div></div><div class="formgrid" style="--cols:3">'
        + UI.field('Name', UI.input(draft ? draft.name : e.name, { attrs: 'data-ef="name"' + (e && !draft ? ' readonly' : '') }))
        + (proto === 'soap' ? UI.field('Operation', UI.select(soapOps(c).map((o) => ({ value: opKey(o), label: o.name + ' (' + o.port + ', SOAP ' + o.soapVersion + ')' + (o.writeLike ? ', named like a write' : '') })), curOp ? opKey(curOp) : '', 'data-ef="sop"'), 'From the WSDL.') : proto === 'odata' ? UI.field('Entity set', UI.select(odataSets(c).map((x) => ({ value: x.name, label: x.name + (x.kind === 'singleton' ? ' (singleton)' : '') })), curSet ? curSet.name : '', 'data-ef="oset"'), 'From $metadata.') : UI.field(proto === 'graphql' ? 'Sub-path' : 'Path', UI.input(def.path, { placeholder: proto === 'graphql' ? 'empty: the base URL' : '/people/{id}', attrs: 'data-ef="path"' })))
        + UI.field('Paging', UI.select(pagingKinds, def.paging.kind, 'data-ef="pagingKind"'))
        + UI.field('Items at', UI.input(def.mapping.items || '', { placeholder: proto === 'graphql' ? '/data/people/nodes' : proto === 'soap' ? '/GetOrdersResponse/GetOrdersResult/Order' : proto === 'odata' ? 'empty: /value of the entity set' : '/data/items or data.items', attrs: 'data-ef="items"' })) + '</div>'
        + UI.check('Offer to app lookups', draft ? !!draft.lookups : !!(e && e.lookups), 'data-ef-lookups')
        + (proto === 'graphql' ? graphqlEditor(def, gs) : '')
        + (proto === 'soap' ? soapEditor(def, curOp) : '')
        + (proto === 'odata' ? odataEditor(def, curSet) : '')
        + UI.field('Paging settings', UI.textarea(pretty(def.paging), { rows: 3, attrs: 'class="textarea mono" data-ef="paging"' }), proto === 'graphql' ? 'Values go into variables. page: param, start, sizeParam, size; offset: offsetParam, limitParam, size; cursor: param (the after variable), sizeParam (first), next (/data/x/pageInfo/endCursor), hasNext (/data/x/pageInfo/hasNextPage).' : proto === 'soap' ? 'Values go into input fields. page: param, start, sizeParam, size; offset: offsetParam, limitParam, size; cursor: param, next, hasNext.' : proto === 'odata' ? 'offset: $skip and $top with size; link: the server\'s @odata.nextLink, kept under the base URL; maxPages caps either.' : 'page: param, start, sizeParam, size; offset: offsetParam, limitParam, size; cursor: param, next (where the next cursor is), hasNext; link: the Link header, kept under the base URL.')
        + UI.field('Fields', UI.textarea(pretty(def.mapping.fields), { rows: 4, attrs: 'class="textarea mono" data-ef="fields"' }), 'A list of {"name", "path", "type": string, number, boolean, date or json}. Without fields every top-level key is a column.')
        + UI.field('Parameters', UI.textarea(pretty(def.params), { rows: 3, attrs: 'class="textarea mono" data-ef="params"' }), proto === 'graphql' ? 'Typed as for saved queries; a variable written "{name}" takes the parameter with its type. The query text never takes parameters.' : proto === 'soap' ? 'Typed as for saved queries; an argument written {name} takes the parameter, escaped as text.' : proto === 'odata' ? 'Typed as for saved queries; {name} in the filter becomes a literal of the property it is compared with, in the search a quoted phrase.' : 'Typed as for saved queries; {name} in the path and query takes them, percent-encoded.')
        + (proto === 'soap' ? '' : UI.field('Query parameters', UI.textarea(pretty(def.query), { rows: 2, attrs: 'class="textarea mono" data-ef="query"' }), proto === 'odata' ? 'Custom query options only (names without $). No credential literals.' : 'Name to value or {param}. No credential literals.'))
        + '<div data-eerr></div><div class="hstack wrap">' + UI.btn('Save endpoint', { kind: 'primary', attrs: 'data-esave' }) + (e && !draft ? UI.btn('Delete endpoint', { kind: 'danger', attrs: 'data-edelete' }) : '') + '</div></div>'
        + '<div class="panel"><div class="eyebrow">Test call</div>' + paramInputs(def.params, vals, 'data-ep') + '<div class="hstack">' + UI.btn('Test call', { icon: 'play', attrs: 'data-etest' }) + '<span class="muted" style="font-size:12px">Runs the definition as edited, with the connection\'s authentication, and shows the mapped rows.</span></div>'
        + (res ? (res.error ? errBox(res.error) : rowsTable(res.out)) : '') + '</div>';
    }
    html += '</div>';
    return {
      html,
      bind() {
        ctx.on('click', '[data-erow]', (ev, t) => { st.esel[c.id] = t.dataset.erow; st.edraft = null; st.eresult = null; done(); });
        ctx.on('click', '[data-enew]', () => { st.edraft = { conn: c.id, name: '', lookups: false, def: blankDef(c) }; st.esel[c.id] = null; st.eresult = null; done(); });
        ctx.on('click', '[data-wrefresh]', async () => {
          try { const out = await App.post('/api/admin/rest-connections/' + enc(c.id) + '/wsdl', {}); ctx.toast('<span>WSDL read again: ' + soapOps(out.connection).length + ' operations.' + (out.missing.length ? ' Gone: ' + out.missing.map(esc).join(', ') + '.' : '') + ' Audit entry written.</span>', out.missing.length ? 'warn' : 'ok', 6000); reload(); }
          catch (err) { App.fail(err); }
        });
        ctx.on('click', '[data-wupload]', () => wsdlModal(ctx, c, reload));
        ctx.on('click', '[data-mrefresh]', async () => {
          try { const out = await App.post('/api/admin/rest-connections/' + enc(c.id) + '/odata/metadata', {}); ctx.toast('<span>$metadata read again: ' + odataSets(out.connection).length + ' entity sets.' + (out.missing.length ? ' Gone: ' + out.missing.map(esc).join(', ') + '.' : '') + ' Audit entry written.</span>', out.missing.length ? 'warn' : 'ok', 6000); reload(); }
          catch (err) { App.fail(err); }
        });
        ctx.on('click', '[data-oimport]', () => openapiModal(ctx, c, reload));
        ctx.on('click', '[data-rtest]', async () => {
          try { const t = await App.post('/api/admin/rest-connections/' + enc(c.id) + '/test'); ctx.toast('<span>' + esc(t.detail) + '</span>', t.health === 'healthy' ? 'ok' : t.health === 'degraded' ? 'warn' : 'danger', 6000); reload(); }
          catch (err) { App.fail(err); }
        });
        ctx.on('click', '[data-rremove]', async () => {
          const ok = await ctx.confirm({ title: 'Remove ' + esc(c.name), tag: 'destructive', tone: 'danger', body: '<p class="fg2" style="margin:0">The connection, its endpoints and its sealed secret are deleted. App entities and knowledge sources that read from it must go first.</p>', ok: 'Remove' });
          if (!ok) return;
          try { await App.del('/api/admin/rest-connections/' + enc(c.id)); st.restSel = null; ctx.toast('<span>' + esc(c.name) + ' removed. Audit entry written.</span>', 'ok'); reload(); } catch (err) { App.fail(err); }
        });
        ctx.on('click', '[data-rsave]', async () => {
          const v = (k) => ctx.$('[data-rs="' + k + '"]').value;
          try {
            await App.patch('/api/admin/rest-connections/' + enc(c.id), { baseUrl: v('baseUrl').trim(), label: v('label'), zone: v('zone'), timeoutMs: Math.round(+v('timeoutMs')), maxBytes: Math.round(+v('maxBytes')), headers: parseJson(v('headers'), 'Default headers') || {} });
            ctx.toast('<span>Settings saved. Audit entry written.</span>', 'ok'); reload();
          } catch (err) { ctx.$('[data-rerr]').innerHTML = errBox(err); }
        });
        ctx.on('click', '[data-rauth]', () => authModal(ctx, c, reload));
        if (!def) return;
        const read = () => {
          const v = (k) => { const i = ctx.$('[data-ef="' + k + '"]'); return i ? i.value : ''; };
          const paging = parseJson(v('paging'), 'Paging settings') || { kind: 'none' };
          paging.kind = v('pagingKind');
          if (proto === 'odata' && paging.kind === 'offset') { paging.offsetParam = '$skip'; paging.limitParam = '$top'; }
          const d = { path: proto === 'soap' || proto === 'odata' ? '' : v('path').trim(), params: parseJson(v('params'), 'Parameters') || [], query: proto === 'soap' ? {} : parseJson(v('query'), 'Query parameters') || {}, paging: paging.kind === 'none' ? { kind: 'none' } : paging, mapping: { items: v('items').trim(), fields: parseJson(v('fields'), 'Fields') || [] } };
          if (proto === 'graphql') d.graphql = { query: v('gquery'), variables: parseJson(v('gvars'), 'Variables') || {} };
          if (proto === 'soap') {
            const [operation, port] = (v('sop') || '|').split('|');
            const args = {};
            (ctx.$$ ? ctx.$$('[data-sarg]') : document.querySelectorAll('#main [data-sarg]')).forEach((i) => { if (i.value !== '') args[i.dataset.sarg] = i.value; });
            const conf = ctx.$('[data-ef-confirm]');
            d.soap = { operation, port, args, confirmRead: !!(conf && conf.checked) };
          }
          if (proto === 'odata') {
            const picked = (attr) => Array.prototype.slice.call(document.querySelectorAll('#main [' + attr + ']')).filter((i) => i.checked).map((i) => i.getAttribute(attr));
            const o = { entitySet: v('oset'), select: picked('data-osel'), expand: picked('data-oexp'), count: !!(ctx.$('[data-ef-ocount]') && ctx.$('[data-ef-ocount]').checked) };
            if (v('ofilter').trim()) o.filter = v('ofilter').trim();
            if (v('oorder').trim()) o.orderby = v('oorder').trim();
            if (v('osearch').trim()) o.search = v('osearch').trim();
            d.odata = o;
          }
          return { name: v('name').trim(), lookups: !!(ctx.$('[data-ef-lookups]') && ctx.$('[data-ef-lookups]').checked), definition: d };
        };
        // Picking another entity set redraws its property pickers.
        ctx.on('change', '[data-ef="oset"]', () => {
          let body;
          try { body = read(); } catch (err) { ctx.$('[data-eerr]').innerHTML = errBox(err); return; }
          const set = findSet(c, body.definition.odata.entitySet);
          body.definition.odata = { entitySet: body.definition.odata.entitySet, select: [], expand: [], count: false };
          body.definition.paging = set && set.kind === 'set' ? { kind: 'link', maxPages: 20 } : { kind: 'none' };
          st.edraft = { conn: c.id, name: body.name, lookups: body.lookups, def: body.definition, editing: e ? e.name : null };
          done();
        });
        // Picking another operation redraws its argument rows, keeping what was typed elsewhere.
        ctx.on('change', '[data-ef="sop"]', () => {
          let body;
          try { body = read(); } catch (err) { ctx.$('[data-eerr]').innerHTML = errBox(err); return; }
          const op = findOp(c, body.definition.soap);
          body.definition.soap.args = {};
          body.definition.soap.confirmRead = false;
          if (op) body.definition.mapping.items = '/' + (op.output || op.name + 'Response');
          st.edraft = { conn: c.id, name: body.name, lookups: body.lookups, def: body.definition, editing: e ? e.name : null };
          done();
        });
        ctx.on('click', '[data-gschema]', async () => {
          try { st.gschema[c.id] = await App.get('/api/admin/rest-connections/' + enc(c.id) + '/graphql/schema'); done(); }
          catch (err) { App.fail(err); }
        });
        ctx.on('click', '[data-guse]', () => {
          const sel = ctx.$('[data-gfield]');
          const f = gs && sel ? gs.fields.find((x) => x.name === sel.value) : null;
          if (!f) return;
          let body;
          try { body = read(); } catch (err) { ctx.$('[data-eerr]').innerHTML = errBox(err); return; }
          const sk = fieldSkeleton(f);
          body.definition.graphql = sk;
          body.definition.mapping.items = '/data/' + f.name;
          const known = new Set(body.definition.params.map((p) => p.name));
          (f.args || []).forEach((a) => { const n = a.name.replace(/[^a-z0-9_]/gi, '_').toLowerCase(); if (!known.has(n) && /^[a-z]/.test(n)) body.definition.params.push({ name: n, type: /^(Int|Float)/.test(a.type) ? 'number' : /^Boolean/.test(a.type) ? 'boolean' : 'string', required: /!$/.test(a.type) }); });
          st.edraft = { conn: c.id, name: body.name, lookups: body.lookups, def: body.definition, editing: e ? e.name : null };
          done();
        });
        ctx.on('click', '[data-esave]', async () => {
          try {
            const body = read();
            const out = await App.post('/api/admin/rest-connections/' + enc(c.id) + '/endpoints', body);
            st.edraft = null; st.esel[c.id] = out.name;
            ctx.toast('<span>Endpoint ' + esc(out.name) + ' saved as version ' + out.version + '. Audit entry written.</span>', 'ok'); reload();
          } catch (err) { ctx.$('[data-eerr]').innerHTML = errBox(err); }
        });
        ctx.on('click', '[data-edelete]', async () => {
          const ok = await ctx.confirm({ title: 'Delete endpoint ' + esc(e.name), tone: 'danger', ok: 'Delete', body: '<p class="fg2" style="margin:0">Entities, knowledge sources and lookups that read it must go first.</p>' });
          if (!ok) return;
          try { await App.del('/api/admin/rest-connections/' + enc(c.id) + '/endpoints/' + enc(e.name)); st.esel[c.id] = null; reload(); } catch (err) { App.fail(err); }
        });
        ctx.on('click', '[data-etest]', async () => {
          let body;
          try { body = read(); } catch (err) { ctx.$('[data-eerr]').innerHTML = errBox(err); return; }
          const params = readParams(ctx.$('#main') || document, 'data-ep', body.definition.params);
          st.eparams[c.id] = params;
          if (draft) st.edraft = { conn: c.id, name: body.name, lookups: body.lookups, def: body.definition };
          try { st.eresult = { conn: c.id, out: await App.post('/api/admin/rest-connections/' + enc(c.id) + '/endpoints/_draft/test', { definition: body.definition, params, limit: 20 }) }; }
          catch (err) { st.eresult = { conn: c.id, error: err }; }
          done();
        });
      }
    };
  }

  /** The GraphQL query and its variables, with the schema helper's root fields to start from. */
  function graphqlEditor(def, gs) {
    const g = def.graphql || { query: '', variables: {} };
    return '<div class="panel"><div class="phead"><div class="eyebrow">GraphQL query</div>' + UI.btn(gs ? 'Reload the schema' : 'Load the schema', { size: 'sm', icon: 'refresh', attrs: 'data-gschema' }) + '</div>'
      + (gs ? '<div class="hstack wrap">' + UI.field('Root field', UI.select(gs.fields.map((f) => ({ value: f.name, label: f.name + (f.args.length ? '(' + f.args.map((a) => a.name + ': ' + a.type).join(', ') + ')' : '') + ': ' + f.type })), '', 'data-gfield'), (gs.queryType ? 'Fields of ' + esc(gs.queryType) + '. ' : '') + 'Use one to start a query; its arguments become variables and parameters.') + UI.btn('Use field', { size: 'sm', attrs: 'data-guse' }) + '</div>' : '')
      + UI.field('Query', UI.textarea(g.query, { rows: 8, attrs: 'class="textarea mono" data-ef="gquery"' }), 'One query operation (fragments allowed). Mutations, subscriptions and introspection are refused before anything is sent.')
      + UI.field('Variables', UI.textarea(pretty(g.variables || {}), { rows: 3, attrs: 'class="textarea mono" data-ef="gvars"' }), 'Name to a JSON value, or a string with {param}: "{active}" alone keeps the parameter\'s type.') + '</div>';
  }

  /** An OData entity set's query options: $select and $expand pickers, the filter with the property names, $orderby, $search. */
  function odataEditor(def, set) {
    const o = def.odata || { select: [], expand: [] };
    if (!set) return UI.notice('Pick an entity set from $metadata.', 'warn');
    const props = set.properties || [];
    const navs = set.navigation || [];
    const single = set.kind === 'singleton';
    return '<div class="panel"><div class="phead"><div class="eyebrow">' + esc(set.name) + (single ? ' (singleton)' : '') + '</div><span class="muted" style="font-size:12px"><span class="mono">' + esc(set.entityType) + '</span>, ' + props.length + ' properties</span></div>'
      + '<fieldset class="cs-fs"><legend class="eyebrow">$select (none: every property)</legend><div class="hstack wrap">' + props.map((p) => UI.check(p.name + (p.key ? ' (key)' : ''), (o.select || []).indexOf(p.name) >= 0, 'data-osel="' + esc(p.name) + '"')).join('') + '</div></fieldset>'
      + (navs.length ? '<fieldset class="cs-fs"><legend class="eyebrow">$expand (one level)</legend><div class="hstack wrap">' + navs.map((n) => UI.check(n.name + (n.collection ? ' (many)' : ''), (o.expand || []).indexOf(n.name) >= 0, 'data-oexp="' + esc(n.name) + '"')).join('') + '</div></fieldset>' : '')
      + (single ? '' : UI.field('$filter', UI.textarea(o.filter || '', { rows: 2, attrs: 'class="textarea mono" data-ef="ofilter" placeholder="contains(Name, {q}) and Price le {max}"' }), 'Properties: ' + props.map((p) => esc(p.name) + ' (' + esc(p.type.replace(/^Edm\./, '')) + ')').join(', ') + '. Operators eq ne gt ge lt le and or not in; the standard string, date and math functions; {param} placeholders.')
        + '<div class="formgrid" style="--cols:2">' + UI.field('$orderby', UI.input(o.orderby || '', { placeholder: 'Price desc, Name', attrs: 'data-ef="oorder"' })) + UI.field('$search', UI.input(o.search || '', { placeholder: '{q} AND blue', attrs: 'data-ef="osearch"' }), 'Words, "phrases", AND, OR, NOT; {param} becomes a quoted phrase.') + '</div>'
        + UI.check('Ask for the total count ($count=true)', !!o.count, 'data-ef-ocount')) + '</div>';
  }

  /** OpenAPI import: a document by URL or pasted, its operations listed, the chosen GET operations made endpoints. */
  function openapiModal(ctx, c, reload) {
    let ops = (c.openapi && c.openapi.operations) || [];
    const list = () => (ops.length
      ? '<div class="vstack" role="group" aria-label="Operations" style="gap:8px;max-height:320px;overflow:auto">' + ops.map((o) => '<div>' + UI.check(o.method + ' ' + o.path + (o.summary ? ': ' + o.summary : ''), false, 'data-oop="' + esc(o.operationId) + '"' + (o.importable ? '' : ' disabled')) + '<div class="muted" style="font-size:12px">' + (o.importable ? 'Becomes <span class="mono">' + esc(o.name) + '</span>, paging ' + esc(o.paging.kind) + ', ' + (o.mapping.fields.length ? o.mapping.fields.length + ' fields' : 'every key') + (o.mapping.items ? ' at <span class="mono">' + esc(o.mapping.items) + '</span>' : '') + (o.notes.length ? '. ' + o.notes.map(esc).join(' ') : '') : esc(o.reason || 'Not importable.')) + '</div></div>').join('') + '</div>'
      : '<div class="muted" style="font-size:12px">Read a document to list its operations.</div>');
    ctx.modal({
      title: 'Import from OpenAPI into ' + esc(c.name),
      body: UI.field('Document URL', UI.input((c.openapi && c.openapi.url) || '', { placeholder: 'https://api.example.com/openapi.json', attrs: 'data-ou' }), 'OpenAPI 3 or Swagger 2.0, JSON or YAML, fetched through the egress guard (4 MB); its host must be on the tenant\'s list of allowed hosts.')
        + UI.field('Or the document', UI.textarea('', { rows: 5, attrs: 'class="textarea mono" data-ot' }), 'Pasted (up to 256 KB here).')
        + '<div class="hstack">' + UI.btn('Read the document', { attrs: 'data-oread' }) + '</div><div data-olist>' + list() + '</div><div data-err></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Import the chosen operations', { kind: 'primary', attrs: 'data-go' }),
      onMount(m) {
        const q = (sel) => m.querySelector(sel);
        q('[data-oread]').addEventListener('click', async () => {
          const text = q('[data-ot]').value.trim();
          const url = q('[data-ou]').value.trim();
          try {
            const out = await App.post('/api/admin/rest-connections/' + enc(c.id) + '/openapi', text ? { document: text } : { url });
            ops = out.operations;
            q('[data-olist]').innerHTML = list();
            q('[data-err]').innerHTML = out.notes.length ? UI.notice(out.notes.map(esc).join(' '), 'warn') : '';
          } catch (err) { q('[data-err]').innerHTML = errBox(err); }
        });
        q('[data-go]').addEventListener('click', async () => {
          const chosen = Array.prototype.slice.call(m.querySelectorAll('[data-oop]')).filter((i) => i.checked && !i.disabled).map((i) => ({ operationId: i.getAttribute('data-oop') }));
          if (!chosen.length) { q('[data-err]').innerHTML = UI.notice('Choose at least one GET operation.', 'warn'); return; }
          try {
            const out = await App.post('/api/admin/rest-connections/' + enc(c.id) + '/openapi/import', { operations: chosen });
            App.closeOverlay();
            ctx.toast('<span>' + out.created.length + ' endpoint' + (out.created.length === 1 ? '' : 's') + ' made' + (out.created.length ? ': ' + out.created.map((x) => esc(x.endpoint)).join(', ') : '') + '.' + (out.refused.length ? ' Refused: ' + out.refused.map((x) => esc(x.operationId) + ' (' + esc(x.reason) + ')').join('; ') + '.' : '') + ' Audit entry written.</span>', out.refused.length ? 'warn' : 'ok', 8000);
            reload();
          } catch (err) { q('[data-err]').innerHTML = errBox(err); }
        });
      }
    });
  }

  /** A SOAP operation's input fields as argument rows. */
  function soapEditor(def, op) {
    const s = def.soap || { args: {} };
    if (!op) return UI.notice('Pick an operation from the WSDL.', 'warn');
    const fields = op.fields && op.fields.length ? op.fields : Object.keys(s.args || {}).map((n) => ({ name: n, type: 'text', minOccurs: 0, maxOccurs: 1 }));
    return '<div class="panel"><div class="phead"><div class="eyebrow">Arguments of ' + esc(op.name) + '</div><span class="muted" style="font-size:12px">' + esc(op.style) + ', SOAP ' + esc(op.soapVersion) + (op.soapAction ? ', action <span class="mono">' + esc(op.soapAction) + '</span>' : '') + '</span></div>'
      + (fields.length ? '<div class="formgrid" style="--cols:3">' + fields.map((f) => UI.field(f.name, UI.input((s.args || {})[f.name] || '', { placeholder: f.type + (f.minOccurs ? ', required' : '') + (f.maxOccurs !== 1 ? ', repeats' : ''), attrs: 'data-sarg="' + esc(f.name) + '"' }), 'Text or {param}; escaped, never XML.')).join('') + '</div>' : '<div class="muted" style="font-size:12px">The WSDL lists no input fields for this operation.</div>')
      + (op.writeLike ? UI.notice(esc(op.name) + ' is named like a write. API connections only read in this release: save it only if the operation reads.', 'warn') + UI.check('This operation only reads', !!s.confirmRead, 'data-ef-confirm') : '') + '</div>';
  }

  function wsdlModal(ctx, c, reload) {
    ctx.modal({
      title: 'WSDL for ' + esc(c.name),
      body: UI.field('WSDL URL', UI.input(c.wsdlUrl || '', { placeholder: 'https://api.example.com/svc?wsdl', attrs: 'data-wu' }), 'Fetched through the egress guard; its host must be on the tenant\'s list of allowed hosts.')
        + UI.field('Or the document', UI.textarea('', { rows: 6, attrs: 'class="textarea mono" data-wt' }), 'Pasted WSDL 1.1 (up to 256 KB here). Imports are not followed.') + '<div data-err></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Read the WSDL', { kind: 'primary', attrs: 'data-go' }),
      onMount(m) {
        m.querySelector('[data-go]').addEventListener('click', async () => {
          const text = m.querySelector('[data-wt]').value.trim();
          const url = m.querySelector('[data-wu]').value.trim();
          try {
            const out = await App.post('/api/admin/rest-connections/' + enc(c.id) + '/wsdl', text ? { wsdl: text } : { wsdlUrl: url });
            App.closeOverlay();
            ctx.toast('<span>WSDL read: ' + soapOps(out.connection).length + ' operations.' + (out.missing.length ? ' Gone: ' + out.missing.map(esc).join(', ') + '.' : '') + '</span>', out.missing.length ? 'warn' : 'ok', 6000);
            reload();
          } catch (err) { m.querySelector('[data-err]').innerHTML = errBox(err); }
        });
      }
    });
  }

  /** The authentication form, shared by registering and changing it. */
  function authFields(a) {
    a = a || { kind: 'none' };
    return UI.field('Authentication', UI.select(AUTH, a.kind, 'data-ak'))
      + '<div class="formgrid" data-awrap>' + UI.field('User name', UI.input(a.username || '', { attrs: 'data-au autocomplete="off"' })) + UI.field('Header name', UI.input(a.headerName || '', { placeholder: 'X-Api-Key', attrs: 'data-ah' })) + UI.field('Query parameter', UI.input(a.queryName || '', { placeholder: 'api_key', attrs: 'data-aq' })) + UI.field('Token URL', UI.input(a.tokenUrl || '', { placeholder: 'https://login.example.com/oauth/token', attrs: 'data-at' })) + UI.field('Client id', UI.input(a.clientId || '', { attrs: 'data-ac autocomplete="off"' })) + UI.field('Scope', UI.input(a.scope || '', { attrs: 'data-as' })) + '</div>'
      + UI.field('Secret', '<input type="password" class="input" data-asec autocomplete="new-password">', 'A password, token, API key or client secret, sealed with the tenant key and never shown again; or a vault reference (vault:path#key) you can read, resolved as you at each call.');
  }
  function authBind(m) {
    const q = (s) => m.querySelector(s);
    const show = () => {
      const k = q('[data-ak]').value;
      const vis = { '[data-au]': k === 'basic', '[data-ah]': k === 'api-key-header', '[data-aq]': k === 'api-key-query', '[data-at]': k === 'oauth2-client', '[data-ac]': k === 'oauth2-client', '[data-as]': k === 'oauth2-client' };
      Object.keys(vis).forEach((s) => { q(s).closest('.field').hidden = !vis[s]; });
      q('[data-asec]').closest('.field').hidden = k === 'none';
    };
    q('[data-ak]').addEventListener('change', show); show();
    return () => {
      const k = q('[data-ak]').value;
      const o = { kind: k };
      if (k === 'basic') o.username = q('[data-au]').value.trim();
      if (k === 'api-key-header') o.headerName = q('[data-ah]').value.trim();
      if (k === 'api-key-query') o.queryName = q('[data-aq]').value.trim();
      if (k === 'oauth2-client') { o.tokenUrl = q('[data-at]').value.trim(); o.clientId = q('[data-ac]').value.trim(); if (q('[data-as]').value.trim()) o.scope = q('[data-as]').value.trim(); }
      const sec = q('[data-asec]').value;
      if (k !== 'none' && sec) o.secret = sec;
      return o;
    };
  }

  function authModal(ctx, c, reload) {
    ctx.modal({
      title: 'Authentication for ' + esc(c.name),
      body: authFields(c.auth) + '<div data-err></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save', { kind: 'primary', attrs: 'data-go' }),
      onMount(m) {
        const get = authBind(m);
        m.querySelector('[data-go]').addEventListener('click', async () => {
          try { await App.patch('/api/admin/rest-connections/' + enc(c.id), { auth: get() }); App.closeOverlay(); ctx.toast('<span>Authentication saved. Test the connection to check it.</span>', 'ok'); reload(); }
          catch (err) { m.querySelector('[data-err]').innerHTML = errBox(err); }
        });
      }
    });
  }

  /** `protocol` preselects the protocol (the Non-REST group opens it on GraphQL). */
  function registerRest(onDone, protocol) {
    const proto0 = PROTOCOLS.some((x) => x.value === protocol) ? protocol : 'rest';
    App.modal({
      title: 'Register an API',
      body: UI.notice('The base URL\'s host must be on this tenant\'s list of allowed hosts (Registry, Allowed hosts); an internal host also needs the operator\'s service allow-list.', 'info')
        + '<div class="formgrid">' + UI.field('Name', UI.input('', { placeholder: 'crm-api', attrs: 'data-rn' })) + UI.field('Protocol', UI.select(PROTOCOLS, proto0, 'data-rproto'), 'GraphQL sends queries only; SOAP reads the operations from a WSDL; OData reads the entity sets from $metadata.') + UI.field('Base URL', UI.input('', { placeholder: 'https://api.example.com/v1', attrs: 'data-rb' }), 'For GraphQL, the endpoint itself; for SOAP, the prefix every port address must start with; for OData, the service root.') + UI.field('Label ceiling', UI.select(LABELS, 'internal', 'data-rl')) + UI.field('Network zone', UI.select(ZONES, 'data', 'data-rz')) + UI.field('Timeout, ms', UI.input('10000', { type: 'number', attrs: 'data-rt' })) + UI.field('Size cap, bytes', UI.input('1048576', { type: 'number', attrs: 'data-rm' })) + '</div>'
        + '<div data-wsdlwrap>' + UI.field('WSDL URL', UI.input('', { placeholder: 'https://api.example.com/svc?wsdl', attrs: 'data-rw' }), 'Fetched through the egress guard, up to 2 MB; its host must be on the list too.') + UI.field('Or the WSDL document', UI.textarea('', { rows: 4, attrs: 'class="textarea mono" data-rwt' }), 'WSDL 1.1, pasted. No DOCTYPE; imports are not followed.') + '</div>'
        + authFields(null) + '<div data-err></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Register', { kind: 'primary', attrs: 'data-go' }),
      onMount(m) {
        const get = authBind(m);
        const q = (s) => m.querySelector(s);
        const showProto = () => {
          const p = q('[data-rproto]').value;
          q('[data-wsdlwrap]').hidden = p !== 'soap';
          q('[data-rb]').placeholder = p === 'graphql' ? 'https://api.example.com/graphql' : p === 'soap' ? 'https://api.example.com/svc' : p === 'odata' ? 'https://api.example.com/odata/v4' : 'https://api.example.com/v1';
        };
        q('[data-rproto]').addEventListener('change', showProto); showProto();
        q('[data-go]').addEventListener('click', async () => {
          try {
            const protocol = q('[data-rproto]').value;
            const body = { name: q('[data-rn]').value.trim(), baseUrl: q('[data-rb]').value.trim(), label: q('[data-rl]').value, zone: q('[data-rz]').value, timeoutMs: Math.round(+q('[data-rt]').value || 10000), maxBytes: Math.round(+q('[data-rm]').value || 1048576), auth: get() };
            if (protocol !== 'rest') body.protocol = protocol;
            if (protocol === 'soap') { const t = q('[data-rwt]').value.trim(); if (t) body.wsdl = t; else body.wsdlUrl = q('[data-rw]').value.trim(); }
            const c = await App.post('/api/admin/rest-connections', body);
            App.closeOverlay();
            App.toast('<span>' + PROTO_NAME[protocol] + ' connection registered. Add an endpoint and test it.</span>', 'ok');
            onDone(c);
          } catch (err) { q('[data-err]').innerHTML = errBox(err); }
        });
      }
    });
  }

  App.connectionSources = { queriesTab, restPage, registerRest };
})();
