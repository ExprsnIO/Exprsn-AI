(function () {
  const { UI, esc } = App;

  const LABELS = ['public', 'internal', 'confidential', 'restricted'];
  const SIDE = { read: 'read-only', write: 'write', destructive: 'destructive' };
  const AUTH = { none: 'No credentials (network isolation only)', service: 'Service token, sealed on the server', user: 'Per-user token vault' };
  const sidePill = (s, hint) => UI.pill((SIDE[s] || s) + (hint ? ' (hint)' : ''), s === 'read' ? 'ok' : s === 'write' ? 'warn' : s === 'destructive' ? 'danger' : 'outline');
  const healthPill = (h) => UI.pill(h, h === 'healthy' ? 'ok' : h === 'changed' || h === 'unreachable' || h === 'incompatible' || h === 'deregistered' ? 'danger' : h === 'registering' ? 'info' : '');
  const APPROVAL = { pending: 'not approved', approved: 'approved', changed: 'disabled, re-review', rejected: 'disabled, rejected', removed: 'no longer offered' };
  const approvalPill = (s) => UI.pill(APPROVAL[s] || s, s === 'approved' ? 'ok' : s === 'changed' || s === 'rejected' ? 'danger' : 'outline');
  const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'never');
  const short = (h) => (h ? String(h).slice(0, 8) : '');
  const pretty = (v) => JSON.stringify(v, null, 2);

  /** A line diff of two texts (longest common subsequence), as +/- lines. */
  function diffLines(a, b) {
    const x = a.split('\n'), y = b.split('\n');
    const n = x.length, m = y.length;
    const t = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i][j] = x[i] === y[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
    const out = [];
    let i = 0, j = 0;
    while (i < n && j < m) { if (x[i] === y[j]) { out.push('  ' + x[i]); i++; j++; } else if (t[i + 1][j] >= t[i][j + 1]) out.push('- ' + x[i++]); else out.push('+ ' + y[j++]); }
    while (i < n) out.push('- ' + x[i++]);
    while (j < m) out.push('+ ' + y[j++]);
    return out;
  }
  const diffHtml = (lines) => '<pre class="codebox" data-lang="json">' + lines.map((l) => l.startsWith('+') ? '<span style="color:var(--ok-fg)">' + esc(l) + '</span>' : l.startsWith('-') ? '<span style="color:var(--danger-fg)">' + esc(l) + '</span>' : esc(l)).join('\n') + '</pre>';
  const announcement = (t) => pretty({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations });

  App.register({
    id: 'mcp-servers', title: 'MCP servers', live: true, section: 'admin',
    summary: 'Internal MCP servers, tool review with schema hashes, change detection, credentials and profile bindings',
    crumb(st) { const s = (st.servers || []).find((x) => x.id === st.sel); return ['Admin', 'MCP servers'].concat(s ? [s.name] : []); },
    commands: [{ label: 'Register an MCP server', sub: 'MCP servers', run(app) { app.stateFor('mcp-servers').openRegister = true; app.render(); } }],
    states: [
      { title: 'Server unreachable', tone: 'danger', text: 'A server that fails its health check has its tools hidden from bound profiles; runs receive a typed error tool_unavailable.', apply(ctx) { ctx.state.demo = 'unreachable'; ctx.rerender(); } },
      { title: 'Vault connection needed', tone: 'info', text: 'A server that acts with each user\'s own token hides its tools from anyone who has not connected one. Tokens never enter model context.', apply(ctx) { ctx.state.demo = 'vault'; ctx.rerender(); } },
      { title: 'Internal only', tone: 'neutral', text: 'Registration accepts hosts that resolve to internal addresses only, unless the platform allow-list names them.', apply(ctx) { ctx.state.openRegister = 'https://mcp.vendor-saas.com/mcp'; ctx.rerender(); } },
      { title: 'Compatibility failed', tone: 'warn', text: 'A server that speaks only the older HTTP+SSE transport (protocol 2024-11-05) is marked incompatible and its tools are hidden.', apply(ctx) { ctx.state.demo = 'incompatible'; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      const toast = (html, kind, ms) => ctx.toast('<span>' + html + '</span>', kind, ms);
      st.tab = st.tab || 'tools'; st.query = st.query || ''; st.details = st.details || {}; st.reports = st.reports || {};
      const later = () => { if (App.state.route !== 'mcp-servers') return; if (document.querySelector('.overlay')) { setTimeout(later, 250); return; } ctx.rerender(); };
      const load = () => {
        if (st.loading) return;
        st.loading = true;
        Promise.all([App.get('/api/admin/mcp-servers'), App.can('profiles:manage') ? App.get('/api/admin/profiles').catch(() => null) : Promise.resolve(null)])
          .then(([servers, profiles]) => { st.servers = servers; st.profiles = profiles; st.loaded = true; st.loadError = null; st.details = {}; })
          .catch((err) => { st.loadError = err; })
          .finally(() => { st.loading = false; later(); });
      };
      if (!st.loaded && !st.loadError) load();
      const act = async (fn, okMsg, kind) => {
        try { const r = await fn(); st.problem = null; if (okMsg) toast(okMsg, kind || 'ok', 5000); st.loaded = false; load(); return r || true; }
        catch (err) { const pr = err.problem || {}; if (err.status >= 400 && err.status < 500) st.problem = { title: pr.title || 'Refused', detail: err.message, trace: pr.trace_id }; App.fail(err); ctx.rerender(); return null; }
      };
      if (st.loadError || !st.loaded) {
        root.innerHTML = '<div class="page">' + UI.pagehead('MCP servers', 'Internal servers only; every tool is reviewed before a profile can use it', '')
          + (st.loadError ? UI.problem('MCP servers could not be loaded', st.loadError.message, st.loadError.problem && st.loadError.problem.trace_id) + '<div>' + UI.btn('Try again', { attrs: 'data-reload' }) + '</div>' : UI.notice('Loading…', 'info')) + '</div>';
        ctx.on('click', '[data-reload]', () => { st.loadError = null; ctx.rerender(); });
        return;
      }

      const servers = st.servers;
      if (ctx.params.server) { const hit = servers.find((x) => x.id === ctx.params.server || x.name === ctx.params.server); if (hit) st.sel = hit.id; delete ctx.params.server; }
      if (st.demo) {
        const d = st.demo; st.demo = null; st.demoNote = null;
        const pick = (f, note) => { const s = servers.find(f); if (s) { st.sel = s.id; return s; } st.demoNote = note; return null; };
        if (d === 'unreachable') { if (pick((x) => x.health === 'unreachable', 'Every server answers its health checks. A server that stops answering shows here with its tools hidden.')) st.tab = 'health'; }
        else if (d === 'vault') { if (pick((x) => x.auth === 'user', 'No server uses per-user tokens. Register one with per-user authorization to see the connect prompt.')) { st.tab = 'authorization'; st.vaultPrompt = true; } }
        else if (d === 'incompatible') { if (pick((x) => x.health === 'incompatible', 'Every server speaks streamable HTTP. A server that answers with protocol 2024-11-05 is marked incompatible here.')) st.tab = 'health'; }
      }
      const list = servers.filter((x) => !st.query || (x.name + ' ' + x.url + ' ' + x.zone).toLowerCase().indexOf(st.query.toLowerCase()) >= 0);
      if (!servers.find((x) => x.id === st.sel)) st.sel = (servers.find((x) => x.state === 'active') || servers[0] || {}).id;
      const s = servers.find((x) => x.id === st.sel);
      const d = s ? st.details[s.id] : null;
      if (s && !d && !st.fetching) {
        st.fetching = s.id;
        App.get('/api/admin/mcp-servers/' + s.id).then((x) => { st.details[s.id] = x; }).catch((err) => { st.details[s.id] = { error: err }; }).finally(() => { st.fetching = null; later(); });
      }
      const manage = App.can('mcp:manage');
      const active = s && s.state === 'active';

      let body = '';
      if (!s) body = UI.empty('No MCP servers yet', 'Register an internal server; its tools stay hidden until a tool admin approves them.', UI.btn('Register', { kind: 'primary', attrs: 'data-register' }));
      else if (!d) body = UI.notice('Loading…', 'info');
      else if (d.error) body = UI.problem('The server could not be loaded', d.error.message, d.error.problem && d.error.problem.trace_id);
      else if (st.tab === 'tools') {
        const changed = d.tools.filter((t) => t.state === 'changed');
        body = UI.table(['Tool', 'Side effect', 'Schema hash', 'Approval', ''], d.tools.map((t) => ({ cells: ['<span class="mono" style="color:var(--fg)">' + esc(t.name) + '</span>' + (t.confirm === 'always' ? ' <span class="muted" style="font-size:12px">confirm: always</span>' : ''), t.sideEffect ? sidePill(t.sideEffect) : sidePill(t.suggestedSideEffect, true), '<span class="mono">' + esc(short(t.hash)) + '</span>' + (t.approvedHash && t.approvedHash !== t.hash ? ' <span class="muted" style="font-size:12px">was</span> <span class="mono">' + esc(short(t.approvedHash)) + '</span>' : ''), approvalPill(t.state), '<span class="actions">' + (!manage || !active ? '' : t.state === 'changed' ? UI.btn('View diff', { size: 'sm', attrs: 'data-diff="' + esc(t.name) + '"' }) : t.state === 'pending' || t.state === 'rejected' ? UI.btn('Review', { size: 'sm', attrs: 'data-review="' + esc(t.name) + '"' }) : t.state === 'approved' ? UI.btn('Revoke', { size: 'sm', kind: 'ghost', attrs: 'data-revoke="' + esc(t.name) + '"' }) : '') + '</span>'], attrs: 'data-tool="' + esc(t.name) + '"', selected: st.tool === t.name })), { emptyTitle: 'No tools announced', emptyText: 'The server has not answered tools/list yet. Run a compatibility test.' })
          + changed.map((t) => UI.panel('Schema change: ' + esc(t.name), diffHtml(diffLines(pretty(t.approvedSchema || {}), announcement(t))) + '<div class="hstack wrap"><span class="fg2 grow" style="font-size:12px">Approved hash <span class="mono">' + esc(short(t.approvedHash)) + '</span>, announced <span class="mono">' + esc(short(t.hash)) + '</span>. The tool stays disabled until a tool admin approves the new schema.</span>' + (manage ? UI.btn('Reject change', { size: 'sm', attrs: 'data-rejectchange="' + esc(t.name) + '"' }) + UI.btn('Approve new schema', { kind: 'primary', size: 'sm', attrs: 'data-review="' + esc(t.name) + '"' }) : '') + '</div>')).join('')
          + UI.kv([['Authorization', esc(AUTH[s.auth])], ['Protocol', esc(s.protocolVersion ? 'streamable HTTP, ' + s.protocolVersion : 'not negotiated yet')], ['Server', esc(s.serverInfo ? (s.serverInfo.name || '') + ' ' + (s.serverInfo.version || '') : 'unknown')], ['Bound by profiles', d.bindings.length ? d.bindings.map((b) => '<a href="#" data-goprofile="' + esc(b.profile) + '">' + esc(b.profile) + '</a>').join(', ') : 'none']], 4)
          + UI.panel('Bindings and tool budgets', '<div class="fg2" style="font-size:12px">Servers bind to model profiles. A profile carries at most 32 tools; models without the tools capability cannot be bound. In chat, profiles offer the read-only tools that need no confirmation; agent runs use every bound tool and hold write and destructive calls for approval.</div>'
            + UI.table(['Profile', 'Model', 'Tools from this server', 'Tool budget', 'Ceiling', ''], d.bindings.map((b) => ['<a href="#" data-goprofile="' + esc(b.profile) + '">' + esc(b.profile) + '</a>', '<span class="mono">' + esc(b.model || 'no model') + '</span>' + (b.toolsCapable ? '' : ' ' + UI.pill('no tools', 'danger')), esc(b.tools.join(', ')), UI.meter('', b.toolCount + ' of 32', (b.toolCount / 32) * 100, b.toolCount > 24 ? 'warn' : ''), UI.label(b.label, { sm: true }), App.can('profiles:manage') && manage ? UI.btn('Unbind', { size: 'sm', kind: 'ghost', attrs: 'data-unbind="' + esc(b.profileId) + '"' }) : '']), { clickable: false, cls: 'bare', minWidth: '0', emptyTitle: 'Not bound', emptyText: 'Bind the approved tools to a profile.' })
            + '<div>' + UI.btn('Bind to a profile', { size: 'sm', icon: 'plus', attrs: 'data-bind', disabled: !App.can('profiles:manage') || !active, title: App.can('profiles:manage') ? '' : 'Binding changes a profile, which needs profiles:manage' }) + '</div>');
      } else if (st.tab === 'authorization') {
        const mine = d.myToken || { connected: false };
        body = (s.auth === 'user' && st.vaultPrompt && !mine.connected ? UI.notice('<b>Connect your token.</b> ' + esc(s.name) + ' acts with each user\'s own token. You have not connected one, so its tools are hidden for you until you do. The token is sealed on the server and never enters model context.', 'info', UI.btn('Connect token', { kind: 'primary', size: 'sm', attrs: 'data-connect' })) : '')
          + UI.kv([['Mode', esc(AUTH[s.auth])], ['Endpoint', '<span class="mono">' + esc(s.url) + '</span>'], ['Service credential', s.auth === 'service' ? (s.hasCredential ? 'sealed; rotated ' + esc(when(s.credentialRotatedAt)) : 'missing') : 'not used'], ['Token passthrough', UI.pill('never', 'ok') + ' <span class="muted">the server never receives the user\'s session or another server\'s token</span>'], ['Connected users', s.auth === 'user' ? esc(d.connections.length + (mine.connected ? ', including you' : '; you are not connected')) : 'not applicable'], ['Network', 'internal addresses only, checked when each connection is made']], 2)
          + (s.auth === 'user' ? UI.panel('Per-user token vault', UI.table(['User', 'Connected', 'Scopes', 'Expires', ''], d.connections.map((c) => [esc(c.name), c.expired ? UI.pill('expired', 'danger') : UI.pill('connected', 'ok'), '<span class="mono">' + esc(c.scopes || '') + '</span>', esc(c.expiresAt ? when(c.expiresAt) : 'no expiry'), App.me && App.me.user && c.userId === App.me.user.id ? UI.btn('Disconnect', { size: 'sm', kind: 'ghost', attrs: 'data-disconnect' }) : '']), { clickable: false, cls: 'bare', minWidth: '0', emptyTitle: 'Nobody has connected a token', emptyText: 'Each user connects their own; tools stay hidden for users without one.' }) + (mine.connected ? '' : '<div>' + UI.btn('Connect your token', { size: 'sm', attrs: 'data-connect' }) + '</div>')) : '');
      } else if (st.tab === 'health') {
        const failing = s.health === 'unreachable' || s.health === 'incompatible';
        const report = st.reports[s.id];
        body = (failing ? UI.notice('<b>' + (s.health === 'incompatible' ? 'Incompatible.' : 'Unreachable.') + '</b> ' + esc(s.healthDetail || '') + ' Bound profiles hide its tools and runs receive a typed error <span class="mono">tool_unavailable</span>.', 'danger', manage ? UI.btn('Check now', { size: 'sm', attrs: 'data-compat' }) : '') : '')
          + '<div class="stats">' + UI.stat(esc(s.health), 'Health', s.failures ? s.failures + ' failed check' + (s.failures === 1 ? '' : 's') + ' in a row' : 'last check passed') + UI.stat(s.latencyMs == null ? '–' : s.latencyMs + ' ms', 'Handshake and tools/list', 'last successful check') + UI.stat(esc(String(d.tools.filter((t) => t.state === 'approved').length)), 'Approved tools', d.tools.length + ' announced') + UI.stat(esc(when(s.lastOkAt)), 'Last success', 'checked ' + esc(when(s.lastCheckedAt))) + '</div>'
          + (report ? UI.table(['Check', 'Result', 'Detail'], report.map((r) => [esc(r.check), UI.pill(r.result, r.result === 'passed' ? 'ok' : r.result === 'skipped' ? 'outline' : 'danger'), esc(r.detail)]), { clickable: false }) : UI.notice('Run a compatibility test to see each check: internal address, initialize handshake and tools/list with the hash comparison. The polling job repeats it on a schedule.', 'info', manage && active ? UI.btn('Run compatibility test', { size: 'sm', attrs: 'data-compat' }) : ''));
      } else {
        body = (d.events.length ? UI.timeline(d.events.map((e) => ({ title: esc(e.title), text: esc(e.text || ''), meta: esc(when(e.ts)), tone: e.tone }))) : UI.empty('No changes yet', '')) + '<div class="fg2" style="font-size:12px">Approvals, hash changes and health transitions are also written to the audit chain.</div>';
      }

      const disabled = d && d.tools ? d.tools.filter((t) => t.state === 'changed' || t.state === 'rejected').length : 0;
      const notice = !s ? '' : s.state === 'deregistered' ? UI.notice('<b>Deregistered.</b> Its tools left every profile and their registry entries are deprecated.', 'danger')
        : s.health === 'changed' && disabled ? UI.notice('The server changed ' + disabled + ' tool' + (disabled === 1 ? '' : 's') + ' since approval. ' + (disabled === 1 ? 'It no longer matches its approved hash and is' : 'They no longer match their approved hashes and are') + ' disabled in every bound profile.', 'danger', UI.btn('View diff', { size: 'sm', attrs: 'data-diff="' + esc((d.tools.find((t) => t.state === 'changed') || {}).name || '') + '"' }))
          : s.health === 'unreachable' ? UI.notice(esc(s.name) + ' is failing its health checks: ' + esc(s.healthDetail || '') + ' Bound profiles hide its tools and runs receive a typed error.', 'danger', UI.btn('Health', { size: 'sm', attrs: 'data-tab="health"' }))
            : s.health === 'incompatible' ? UI.notice('<b>Compatibility failed.</b> ' + esc(s.healthDetail || '') + ' Its tools stay hidden until the server speaks streamable HTTP.', 'warn', UI.btn('Health', { size: 'sm', attrs: 'data-tab="health"' })) : '';

      root.innerHTML = '<style>.mcp-page > *{flex-shrink:0}.mcp-list{display:flex;flex-direction:column;gap:2px}.mcp-page .tablewrap.bare .meter{min-width:110px}</style>'
        + '<div class="leftpane w320"><div class="hstack"><div class="eyebrow grow">Servers</div>' + (manage ? UI.btn('Register', { size: 'sm', attrs: 'data-register' }) : '') + '</div>'
        + UI.search('Filter servers', 'data-search', st.query).replace('class="search"', 'class="search" style="width:100%"')
        + '<div class="mcp-list">' + list.map((x) => UI.listItem(esc(x.name), esc((x.state === 'deregistered' ? 'deregistered, ' : '') + x.zone + ', ' + x.approved + ' of ' + x.tools + ' tools approved'), { active: s && x.id === s.id, attrs: 'data-server="' + esc(x.id) + '"', right: healthPill(x.state === 'deregistered' ? 'deregistered' : x.health) })).join('') + (list.length ? '' : UI.empty('No servers match', 'Try another word or register a server.')) + '</div>'
        + '<div class="muted" style="font-size:12px;margin-top:auto">Streamable HTTP on internal hosts only. Tools are hashed; a changed schema disables the tool until it is approved again.</div></div>'
        + '<div class="page mcp-page">' + (s ? UI.pagehead(s.name, esc(s.url) + ', zone ' + esc(s.zone) + (disabled ? ' ' + UI.pill(disabled + ' tool' + (disabled === 1 ? '' : 's') + ' disabled', 'danger') : '') + ' ' + UI.pill(s.auth === 'user' ? 'per-user tokens' : s.auth === 'service' ? 'service token' : 'no credentials', 'outline'), manage && active ? UI.btn('Run compatibility test', { attrs: 'data-compat' }) + (s.auth === 'service' ? UI.btn('Rotate credentials', { attrs: 'data-rotate' }) : '') + UI.btn('Deregister', { kind: 'ghost', attrs: 'data-deregister' }) : '') : UI.pagehead('MCP servers', 'Internal servers only; every tool is reviewed before a profile can use it', ''))
        + (st.demoNote ? UI.notice(esc(st.demoNote), 'info') : '')
        + (st.problem ? UI.problem(st.problem.title, st.problem.detail, st.problem.trace) : '')
        + notice
        + (s ? UI.tabs([{ id: 'tools', label: 'Tools', count: d && d.tools ? d.tools.length : s.tools }, { id: 'authorization', label: 'Authorization' }, { id: 'health', label: 'Health' }, { id: 'changes', label: 'Changes', count: d && d.events ? d.events.length : undefined }], st.tab) : '')
        + body
        + '<div><div class="eyebrow" style="margin-bottom:8px">States to design from this page</div>' + UI.states(this.states) + '</div></div>';

      // ---- events ----
      const tool = (name) => (d && d.tools ? d.tools.find((t) => t.name === name) : null);
      ctx.on('click', '[data-server]', (e, t) => { st.sel = t.dataset.server; st.tool = null; st.problem = null; st.vaultPrompt = false; ctx.rerender(); });
      ctx.on('input', '[data-search]', (e, t) => { st.query = t.value; const v = t.value; ctx.rerender(); const i = ctx.$('[data-search]'); i.focus(); i.setSelectionRange(v.length, v.length); });
      ctx.on('click', '[data-tab]', (e, t) => { st.tab = t.dataset.tab; ctx.rerender(); });
      ctx.on('click', '.state-card', (e, t) => ctx.app.applyState(+t.dataset.state));
      ctx.on('click', '[data-goprofile]', (e, t) => { e.preventDefault(); ctx.navigate('profiles', { profile: t.dataset.goprofile }); });
      ctx.on('click', 'tr.row[data-tool]', (e, t) => { if (e.target.closest('button')) return; st.tool = t.dataset.tool; openTool(tool(t.dataset.tool)); });
      ctx.on('click', '[data-review]', (e, t) => reviewTool(tool(t.dataset.review)));
      ctx.on('click', '[data-diff]', (e, t) => { const x = tool(t.dataset.diff); if (!x) return; ctx.modal({ cls: 'wide', title: 'Schema change: ' + esc(x.name) + ' ' + approvalPill(x.state), body: diffHtml(diffLines(pretty(x.approvedSchema || {}), announcement(x))) + UI.kv([['Approved hash', '<span class="mono">' + esc(short(x.approvedHash)) + '</span>'], ['Announced hash', '<span class="mono">' + esc(short(x.hash)) + '</span>'], ['Side-effect class', sidePill(x.sideEffect || x.suggestedSideEffect) + ' <span class="muted">set at review; annotations are hints</span>'], ['Disabled in', esc(d.bindings.filter((b) => b.tools.indexOf(x.name) >= 0).map((b) => b.profile).join(', ') || 'no profile')]], 2) + UI.notice('Approving records the new hash and re-enables the tool in every bound profile. Arguments are validated against the new schema from the next call.', 'info'), actions: (manage ? UI.btn('Reject change', { attrs: 'data-mreject' }) + UI.btn('Approve new schema', { kind: 'primary', attrs: 'data-mapprove' }) : UI.btn('Close', { attrs: 'data-close' })), onMount(m) { const a = m.querySelector('[data-mapprove]'); if (a) a.addEventListener('click', () => { App.closeOverlay(); reviewTool(x); }); const r = m.querySelector('[data-mreject]'); if (r) r.addEventListener('click', () => { App.closeOverlay(); rejectChange(x); }); } }); });
      ctx.on('click', '[data-rejectchange]', (e, t) => rejectChange(tool(t.dataset.rejectchange)));
      ctx.on('click', '[data-revoke]', async (e, t) => {
        const x = tool(t.dataset.revoke);
        const ok = await ctx.confirm({ title: 'Revoke approval for ' + esc(x.name), tag: 'revoke', tone: 'danger', body: '<p class="fg2" style="margin:0">The tool is hidden from every bound profile from the next turn. Runs in progress receive a typed error if they call it.</p>', kv: [['Bound profiles', esc(d.bindings.map((b) => b.profile).join(', ') || 'none')]], ok: 'Revoke' });
        if (ok) act(() => App.post('/api/admin/mcp-servers/' + s.id + '/tools/' + encodeURIComponent(x.name) + '/revoke'), esc(x.name) + ' hidden from ' + d.bindings.length + ' profile' + (d.bindings.length === 1 ? '' : 's') + '.', 'warn');
      });
      ctx.on('click', '[data-compat]', async () => {
        toast('Compatibility test running: internal address, handshake, tools/list.');
        try {
          const r = await App.post('/api/admin/mcp-servers/' + s.id + '/check');
          st.reports[s.id] = r.report; st.loaded = false; load();
          const bad = r.report.filter((x) => x.result === 'failed' || x.result === 'changed');
          ctx.modal({ title: 'Compatibility test: ' + esc(s.name) + ' ' + healthPill(r.health), body: UI.table(['Check', 'Result', 'Detail'], r.report.map((x) => [esc(x.check), UI.pill(x.result, x.result === 'passed' ? 'ok' : x.result === 'skipped' ? 'outline' : 'danger'), esc(x.detail)]), { clickable: false, minWidth: '0' }) + (bad.length ? UI.notice(esc(r.healthDetail || 'Some checks did not pass.'), r.health === 'changed' ? 'warn' : 'danger') : ''), actions: UI.btn('Close', { attrs: 'data-close' }) });
        } catch (err) { App.fail(err, 'Compatibility test failed'); }
      });
      ctx.on('click', '[data-rotate]', () => {
        ctx.modal({ title: 'Rotate credentials for ' + esc(s.name), body: UI.field('New service token', UI.input('', { type: 'password', attrs: 'data-secret autocomplete="off"' }), 'Sealed on the server and never shown again. Issue it at the server first, then paste it here.') + UI.kv([['Currently', s.hasCredential ? 'sealed, rotated ' + esc(when(s.credentialRotatedAt)) : 'missing']], 1), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Rotate', { kind: 'primary', attrs: 'data-ok' }), onMount(m) { m.querySelector('[data-ok]').addEventListener('click', () => { const secret = m.querySelector('[data-secret]').value; App.closeOverlay(); act(() => App.api('PUT', '/api/admin/mcp-servers/' + s.id + '/credential', { secret }), 'Credentials rotated for ' + esc(s.name) + '. Audit entry written.'); }); } });
      });
      ctx.on('click', '[data-deregister]', async () => {
        const ok = await ctx.confirm({ title: 'Deregister ' + esc(s.name), tag: 'destructive', tone: 'danger', body: '<p class="fg2" style="margin:0">All bindings are removed and the tools disappear from ' + d.bindings.length + ' profile' + (d.bindings.length === 1 ? '' : 's') + '. Registry entries for its tools are deprecated and user tokens are deleted.</p>', kv: [['Bound profiles', esc(d.bindings.map((b) => b.profile).join(', ') || 'none')], ['Tools', String(d.tools.length)]], ok: 'Deregister' });
        if (ok) act(() => App.del('/api/admin/mcp-servers/' + s.id), esc(s.name) + ' deregistered. ' + d.tools.length + ' tools removed from routing.', 'danger');
      });
      ctx.on('click', '[data-connect]', () => {
        ctx.modal({ title: 'Connect your token for ' + esc(s.name), body: '<p class="fg2" style="margin:0">Paste a personal access token issued by the service behind <span class="mono">' + esc(s.url) + '</span>. It is sealed with your tenant\'s key, used only when a tool from ' + esc(s.name) + ' runs for you, and never enters model context.</p>' + UI.field('Token', UI.input('', { type: 'password', attrs: 'data-token autocomplete="off"' })) + UI.field('Scopes (for your reference)', UI.input('', { attrs: 'data-scopes', placeholder: 'api, read_repository' })) + UI.field('Expires', UI.input('', { type: 'date', attrs: 'data-exp' })), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Connect', { kind: 'primary', attrs: 'data-ok' }), onMount(m) { m.querySelector('[data-ok]').addEventListener('click', () => { const token = m.querySelector('[data-token]').value; const scopes = m.querySelector('[data-scopes]').value.trim() || null; const exp = m.querySelector('[data-exp]').value; App.closeOverlay(); st.vaultPrompt = false; act(() => App.api('PUT', '/api/mcp/servers/' + s.id + '/token', { token, scopes, expiresAt: exp ? new Date(exp + 'T23:59:59').getTime() : null }), 'Token connected. ' + esc(s.name) + ' tools are now available to you.'); }); } });
      });
      ctx.on('click', '[data-disconnect]', () => act(() => App.del('/api/mcp/servers/' + s.id + '/token'), 'Your token was removed from the vault.'));
      ctx.on('click', '[data-bind]', () => {
        const approved = d.tools.filter((t) => t.state === 'approved');
        const profs = (st.profiles || []).filter((p) => !p.aliasOf);
        if (!approved.length) { toast('Approve at least one tool before binding the server.', 'warn'); return; }
        ctx.modal({ title: 'Bind ' + esc(s.name) + ' to a profile', body: UI.field('Profile', UI.select(profs.map((p) => ({ value: p.id, label: p.name + (p.model ? ', ' + p.model.name : '') + ((p.model && p.model.capabilities.indexOf('tools') < 0) ? ' (no tools)' : '') })), profs[0] ? profs[0].id : '', 'data-prof')) + '<div class="vstack gap6">' + approved.map((t) => UI.check(t.name + ' (' + (SIDE[t.sideEffect] || t.sideEffect) + ')', true, 'data-bt="' + esc(t.name) + '"')).join('') + '</div>' + UI.notice('Binding saves a new version of the profile. Models without the tools capability are refused; a profile carries at most 32 tools.', 'info'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Bind', { kind: 'primary', attrs: 'data-ok' }), onMount(m) { m.querySelector('[data-ok]').addEventListener('click', () => { const profileId = m.querySelector('[data-prof]').value; const tools = Array.prototype.filter.call(m.querySelectorAll('[data-bt]'), (c) => c.checked).map((c) => c.dataset.bt); const p = profs.find((x) => x.id === profileId); App.closeOverlay(); act(() => App.post('/api/admin/mcp-servers/' + s.id + '/bind', { profileId, tools }), esc(s.name) + ' bound to ' + esc(p ? p.name : 'the profile') + '. The tool set applies from the next turn.'); }); } });
      });
      ctx.on('click', '[data-unbind]', async (e, t) => {
        const b = d.bindings.find((x) => x.profileId === t.dataset.unbind);
        const ok = await ctx.confirm({ title: 'Unbind ' + esc(s.name) + ' from ' + esc(b.profile), tone: 'warn', body: '<p class="fg2" style="margin:0">The profile stops offering ' + esc(b.tools.join(', ')) + ' from its next version.</p>', ok: 'Unbind' });
        if (ok) act(() => App.del('/api/admin/mcp-servers/' + s.id + '/bind/' + b.profileId), esc(s.name) + ' unbound from ' + esc(b.profile) + '.');
      });
      ctx.on('click', '[data-register]', () => registerModal(''));
      if (st.openRegister) { const u = typeof st.openRegister === 'string' ? st.openRegister : ''; st.openRegister = false; setTimeout(() => registerModal(u), 30); }

      function reviewTool(x) {
        if (!x) return;
        const suggested = x.sideEffect || x.suggestedSideEffect;
        ctx.modal({ title: (x.state === 'changed' ? 'Approve new schema for ' : 'Review ') + esc(x.name) + ' ' + sidePill(suggested, !x.sideEffect), body: UI.kv([['Schema hash', '<span class="mono">' + esc(short(x.hash)) + '</span>'], ['Annotations', '<span class="mono">' + esc(JSON.stringify(x.annotations || {})) + '</span> <span class="muted">untrusted hints</span>'], ['Description', esc(x.description || 'none')]], 1) + UI.code(pretty(x.inputSchema || {}), 'json') + '<div class="formgrid">' + UI.field('Side-effect class (final)', UI.select([{ value: 'read', label: 'read-only' }, { value: 'write', label: 'write' }, { value: 'destructive', label: 'destructive' }], suggested, 'data-side'), 'The annotation pre-fills the class; the review sets it.') + UI.field('Confirmation', UI.select(['always', 'never'], x.confirm || (suggested === 'read' ? 'never' : 'always'), 'data-confirm'), 'Write and destructive tools always confirm') + UI.field('Max label', UI.select(LABELS, x.label || 'internal', 'data-label')) + '</div>' + (suggested === 'destructive' ? UI.notice('Destructive calls in agent runs need a tool admin other than the run\'s owner to approve each one.', 'warn') : ''), actions: UI.btn('Keep hidden', { attrs: 'data-close' }) + UI.btn('Approve tool', { kind: 'primary', attrs: 'data-ok' }), onMount(m) { m.querySelector('[data-ok]').addEventListener('click', () => { const body = { sideEffect: m.querySelector('[data-side]').value, confirm: m.querySelector('[data-confirm]').value, label: m.querySelector('[data-label]').value }; App.closeOverlay(); act(() => App.post('/api/admin/mcp-servers/' + s.id + '/tools/' + encodeURIComponent(x.name) + '/approve', body), esc(x.name) + ' approved as ' + esc(SIDE[body.sideEffect]) + ', hash ' + esc(short(x.hash)) + ' recorded.'); }); } });
      }
      async function rejectChange(x) {
        if (!x) return;
        const ok = await ctx.confirm({ title: 'Reject schema change', tag: 'disable', tone: 'danger', body: '<p class="fg2" style="margin:0">' + esc(x.name) + ' stays disabled until the server restores the approved schema or a tool admin approves the new one.</p>', ok: 'Reject change' });
        if (ok) act(() => App.post('/api/admin/mcp-servers/' + s.id + '/tools/' + encodeURIComponent(x.name) + '/reject-change'), 'Change rejected. ' + esc(x.name) + ' stays disabled.', 'warn');
      }
      function openTool(x) {
        if (!x) return;
        ctx.drawer({ title: '<span class="mono">' + esc(s.name) + '.' + esc(x.name) + '</span>', body: '<div class="hstack gap6">' + sidePill(x.sideEffect || x.suggestedSideEffect, !x.sideEffect) + approvalPill(x.state) + '</div>' + UI.kv([['Schema hash', '<span class="mono">' + esc(short(x.hash)) + '</span>' + (x.approvedHash && x.approvedHash !== x.hash ? ' <span class="muted">was</span> <span class="mono">' + esc(short(x.approvedHash)) + '</span>' : '')], ['Confirmation', esc(x.confirm || 'set at review')], ['Max label', x.label ? UI.label(x.label, { sm: true }) : 'set at review'], ['Visible in profiles', x.state === 'approved' ? esc(d.bindings.filter((b) => b.tools.indexOf(x.name) >= 0).map((b) => b.profile).join(', ') || 'none yet') : 'none'], ['Registry entry', x.state === 'approved' || x.approvedAt ? '<a href="#" data-goreg>' + esc(s.name + '.' + x.name) + '</a>' : 'created at approval']], 1) + UI.code(announcement(x), 'json') + UI.notice('Annotations are untrusted hints. The reviewed side-effect class is what policy enforces.', 'info'), actions: UI.btn('Close', { kind: 'ghost', attrs: 'data-close' }), onMount(el) { const g = el.querySelector('[data-goreg]'); if (g) g.addEventListener('click', (ev) => { ev.preventDefault(); App.closeOverlay(); ctx.navigate('registry', { entry: s.name + '.' + x.name }); }); } });
      }
      function registerModal(prefill) {
        ctx.modal({
          title: 'Register MCP server', cls: 'wide',
          body: '<div class="formgrid">' + UI.field('Name', UI.input('', { placeholder: 'erp-bridge', attrs: 'data-name' }), 'Lower-case letters, digits and hyphens; tools appear as name.tool') + UI.field('Zone', UI.input('app-internal', { attrs: 'data-zone' }))
            + '<div class="span2">' + UI.field('Endpoint', UI.input(prefill, { placeholder: 'https://<host>.internal/mcp', attrs: 'data-url' }), 'Streamable HTTP. The host must resolve to an internal address unless the platform allow-list names it') + '<div data-urlerr></div></div>'
            + UI.field('Authorization', UI.select([{ value: 'none', label: AUTH.none }, { value: 'service', label: AUTH.service }, { value: 'user', label: AUTH.user }], 'none', 'data-auth')) + UI.field('Service token', UI.input('', { type: 'password', attrs: 'data-cred autocomplete="off"' }), 'Only for a service token; sealed, never shown again')
            + '<div class="span2">' + UI.field('Description', UI.input('', { attrs: 'data-desc' })) + '</div></div>'
            + UI.notice('Registration runs the handshake and tools/list, and hashes every announced tool. Tools stay hidden until a tool admin approves them.', 'info'),
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Register and test', { kind: 'primary', attrs: 'data-ok' }),
          onMount(m) {
            const err = m.querySelector('[data-urlerr]');
            m.querySelector('[data-ok]').addEventListener('click', async () => {
              const body = { name: m.querySelector('[data-name]').value.trim(), url: m.querySelector('[data-url]').value.trim(), zone: m.querySelector('[data-zone]').value.trim() || 'app-internal', auth: m.querySelector('[data-auth]').value, credential: m.querySelector('[data-cred]').value || null, description: m.querySelector('[data-desc]').value.trim() || null };
              const btn = m.querySelector('[data-ok]'); btn.disabled = true; err.innerHTML = '';
              try {
                const r = await App.post('/api/admin/mcp-servers', body);
                App.closeOverlay();
                st.sel = r.id; st.tab = 'tools'; st.reports[r.id] = r.report; st.loaded = false; load();
                toast(esc(r.name) + (r.health === 'healthy' ? ' registered. Its tools wait for review.' : ' registered, but its check did not pass: ' + esc(r.healthDetail || r.health) + '.'), r.health === 'healthy' ? 'ok' : 'warn', 6000);
              } catch (e2) {
                btn.disabled = false;
                const pr = e2.problem || {};
                err.innerHTML = UI.notice('<b>' + esc(pr.title || 'Refused') + '.</b> ' + esc(e2.message) + (pr.reason === 'public-host' ? ' Hosting modes offered: servers on internal hosts, reached over streamable HTTP.' : ''), 'danger');
              }
            });
          }
        });
      }
    }
  });
})();
