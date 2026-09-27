(function () {
  const { UI, esc } = App;

  const PROFILES = [
    { id: 'analyst', model: 'qwen2.5:32b-q4_K_M', short: 'qwen2.5:32b', sub: 'qwen2.5:32b, alias of none', status: 'published', maxLabel: 'confidential', pool: 'gpu-large', residency: 'warm', num_ctx: '16384', temperature: '0.2', prompt: 'prompts/analyst, v4', promptKey: 'prompts/analyst@v4', think: 'medium, users may choose up to high', thinkKey: '{ default: medium, ceiling: high }', fallback: 'general-8b after 8 s queue wait', fallbackKey: '{ profile: general-8b, afterQueueWait: 8s }', stable: 'sha256:41ab..', canary: 'sha256:c07e..', canaryPct: 10, maxTools: 24, maxSchema: 6000, schemaUsed: 3480,
      bindings: [
        { server: 'kb-search', builtin: true, tools: 'all 3 tools', n: 3, confirm: 'never', ceiling: 'confidential' },
        { server: 'jira-internal', tools: 'search_issues, get_issue, create_issue', n: 3, confirm: 'on write', ceiling: 'confidential' },
        { server: 'gitlab-onprem', tools: 'create_merge_request', n: 1, confirm: 'always', ceiling: 'internal', disabled: 'disabled, schema changed' }
      ] },
    { id: 'chat-default', alias: 'general-8b', sub: 'alias, points to general-8b', status: 'alias' },
    { id: 'general-8b', model: 'llama3.1:8b-q5_K_M', short: 'llama3.1:8b', sub: 'llama3.1:8b', status: 'published', maxLabel: 'confidential', pool: 'gpu-large', residency: 'pinned', num_ctx: '8192', temperature: '0.7', prompt: 'prompts/general, v2', promptKey: 'prompts/general@v2', think: 'low, users may choose up to medium', thinkKey: '{ default: low, ceiling: medium }', fallback: 'fast after 5 s queue wait', fallbackKey: '{ profile: fast, afterQueueWait: 5s }', stable: 'sha256:7d21..', canary: null, canaryPct: 0, maxTools: 12, maxSchema: 3000, schemaUsed: 940,
      bindings: [{ server: 'kb-search', builtin: true, tools: 'all 3 tools', n: 3, confirm: 'never', ceiling: 'confidential' }] },
    { id: 'code', alias: 'coder-32b', sub: 'alias, points to coder-32b', status: 'alias' },
    { id: 'coder-32b', model: 'qwen2.5-coder:32b-q4_K_M', short: 'qwen2.5-coder:32b', sub: 'qwen2.5-coder:32b', status: 'in review', maxLabel: 'internal', pool: 'gpu-large', residency: 'warm', num_ctx: '32768', temperature: '0.1', prompt: 'prompts/coder, v1', promptKey: 'prompts/coder@v1', think: 'medium, users may choose up to high', thinkKey: '{ default: medium, ceiling: high }', fallback: 'general-8b after 10 s queue wait', fallbackKey: '{ profile: general-8b, afterQueueWait: 10s }', stable: 'sha256:9f2c..', canary: null, canaryPct: 0, maxTools: 16, maxSchema: 4000, schemaUsed: 1210,
      bindings: [{ server: 'gitlab-onprem', tools: 'get_file, search_code, list_merge_requests', n: 3, confirm: 'never', ceiling: 'internal' }], note: 'The model is evaluated but not approved; the tools capability is withheld until conformance passes. Publishing waits on Models.' },
    { id: 'fast', model: 'llama3.2:3b-q8_0', short: 'llama3.2:3b', sub: 'llama3.2:3b', status: 'published', maxLabel: 'internal', pool: 'cpu-helpers', residency: 'pinned', num_ctx: '4096', temperature: '0.7', prompt: 'prompts/general, v2', promptKey: 'prompts/general@v2', think: 'off', thinkKey: '{ default: off, ceiling: off }', fallback: 'none', fallbackKey: 'none', stable: 'sha256:3c8a..', canary: null, canaryPct: 0, maxTools: 4, maxSchema: 1200, schemaUsed: 0, bindings: [] },
    { id: 'vision', model: 'llama3.2-vision:11b-q4_K_M', short: 'llama3.2-vision:11b', sub: 'llama3.2-vision:11b', status: 'published', maxLabel: 'internal', pool: 'gpu-large', residency: 'warm', num_ctx: '8192', temperature: '0.3', prompt: 'prompts/vision, v1', promptKey: 'prompts/vision@v1', think: 'off', thinkKey: '{ default: off, ceiling: off }', fallback: 'none', fallbackKey: 'none', stable: 'sha256:d04e..', canary: null, canaryPct: 0, maxTools: 8, maxSchema: 2000, schemaUsed: 940,
      bindings: [{ server: 'kb-search', builtin: true, tools: 'all 3 tools', n: 3, confirm: 'never', ceiling: 'confidential' }] }
  ];
  const EMBED = { id: 'embed', model: 'nomic-embed-text:v1.5', short: 'nomic-embed-text', sub: 'nomic-embed-text:v1.5', status: 'published', maxLabel: 'restricted', pool: 'cpu-helpers', residency: 'pinned', num_ctx: '8192', temperature: '0', prompt: 'none', promptKey: 'none', think: 'off', thinkKey: '{ default: off, ceiling: off }', fallback: 'none', fallbackKey: 'none', stable: 'sha256:0c6e..', canary: null, canaryPct: 0, maxTools: 0, maxSchema: 0, schemaUsed: 0, bindings: [], noTools: true };
  const SERVERS = [
    { id: 'kb-search', mode: 'built-in', ceiling: 'confidential', tools: ['search', 'get_passage', 'list_bases'] },
    { id: 'jira-internal', mode: 'remote, internal', ceiling: 'confidential', tools: ['search_issues', 'get_issue', 'create_issue', 'add_comment'] },
    { id: 'gitlab-onprem', mode: 'remote, internal', ceiling: 'internal', tools: ['get_file', 'search_code', 'list_merge_requests', 'create_merge_request'] },
    { id: 'erp-sap', mode: 'remote, internal', ceiling: 'confidential', tools: ['get_vendor', 'list_invoices', 'post_journal'] },
    { id: 'hr-records', mode: 'remote, internal', ceiling: 'restricted', tools: ['get_employee', 'list_absences'] },
    { id: 'browser-sandbox', mode: 'managed per-session', ceiling: 'internal', tools: ['open', 'read_page', 'click'] }
  ];
  const LEVELS = { public: 1, internal: 2, confidential: 3, restricted: 4 };
  const WORKSPACES = [
    { name: 'Finance Ops', label: 'confidential', conv: '1,240 conversations, 7 days' },
    { name: 'People Ops', label: 'internal', conv: '318 conversations, 7 days' },
    { name: 'Field Sales', label: 'internal', conv: '702 conversations, 7 days' }
  ];

  function profileList(st) { return st.showEmbed ? PROFILES.concat([EMBED]) : PROFILES; }
  function resolve(st, p) { if (!p.alias) return p; const target = (st.aliasTarget || {})[p.id] || p.alias; return PROFILES.find((x) => x.id === target) || p; }

  App.register({
    id: 'profiles', title: 'Profiles', summary: 'Pinned model version, options, prompt, pool, residency, ceiling, MCP bindings and tool budgets', section: 'admin',
    crumb: (st, params) => ['Admin', 'Profiles', params.profile || st.selected || 'analyst'],
    label: (st, params) => { const id = params.profile || st.selected || 'analyst'; const p = profileList(st).find((x) => x.id === id); return p ? resolve(st, p).maxLabel : null; },
    commands: [{ label: 'New model profile', sub: 'Profiles', run(app) { app.stateFor('profiles').openNew = true; app.render(); } }],
    states: [
      { title: 'Binding refused', tone: 'danger', text: 'nomic-embed-text lacks the tools capability, so the registry rejects any MCP binding on its profile.', apply(ctx) { ctx.state.showEmbed = true; ctx.state.selected = 'embed'; ctx.state.bindRefused = true; ctx.rerender(); } },
      { title: 'Over tool budget', tone: 'warn', text: '31 tools are bound against a budget of 24. The profile exposes find_tools and loads matches per step.', apply(ctx) { ctx.state.selected = 'analyst'; ctx.state.overBudget = true; ctx.rerender(); } },
      { title: 'Alias repoint', tone: 'info', text: 'Moving chat-default from general-8b to analyst shows which workspaces are affected before it applies.', apply(ctx) { ctx.state.selected = 'chat-default'; ctx.state.openRepoint = 'analyst'; ctx.rerender(); } },
      { title: 'Ceiling conflict', tone: 'danger', text: 'A server reaching restricted data cannot bind to a profile capped at confidential.', apply(ctx) { ctx.state.selected = 'analyst'; ctx.state.openBind = 'hr-records'; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      if (ctx.params.profile) { st.selected = ctx.params.profile; delete ctx.params.profile; }
      st.selected = st.selected || 'analyst'; st.form = st.form || {}; st.pointer = st.pointer || {}; st.aliasTarget = st.aliasTarget || {}; st.extraBindings = st.extraBindings || {}; st.unbound = st.unbound || {}; st.created = st.created || [];
      const list = profileList(st).concat(st.created);
      const p = list.find((x) => x.id === st.selected) || list[0];
      const isAlias = !!p.alias;
      const target = isAlias ? resolve(st, p) : p;
      const f = Object.assign({ model: target.model, pool: target.pool, residency: target.residency, num_ctx: target.num_ctx, temperature: target.temperature, maxLabel: target.maxLabel, prompt: target.prompt, think: target.think, fallback: target.fallback }, st.form[target.id] || {});
      const ptr = st.pointer[target.id] || { stable: target.stable, canary: target.canary, pct: target.canaryPct };
      const bindings = (target.bindings || []).concat(st.extraBindings[target.id] || []).filter((b) => !(st.unbound[target.id] || {})[b.server]);
      const overBudget = st.overBudget && target.id === 'analyst';
      const toolCount = overBudget ? 31 : bindings.reduce((n, b) => n + b.n, 0);
      const schemaUsed = overBudget ? 7860 : target.schemaUsed + bindings.filter((b) => b.added).reduce((n, b) => n + b.n * 260, 0);

      const yaml = 'profile: ' + target.id + '\nmodel: ' + f.model + '\npool: ' + f.pool + '\nresidency: ' + f.residency + '\noptions: { num_ctx: ' + f.num_ctx + ', temperature: ' + f.temperature + ' }\nsystemPrompt: ' + (f.prompt === target.prompt ? target.promptKey : f.prompt.replace(', v', '@v')) + '\nmaxLabel: ' + f.maxLabel + '\nthink: ' + (f.think === target.think ? target.thinkKey : '{ default: ' + f.think.split(',')[0] + ' }') + '\ntools:\n  maxTools: ' + target.maxTools + '\n  maxSchemaTokens: ' + target.maxSchema + (bindings.length ? '\n  mcpServers:' + bindings.map((b) => '\n    - server: ' + b.server + (b.builtin ? '' : '\n      tools: [' + b.tools.replace(/, /g, ', ') + ']') + (b.confirm !== 'never' ? '\n      confirm: ' + (b.confirm === 'on write' ? 'on-write' : b.confirm) : '')).join('') : '');

      const sideList = '<div class="leftpane" style="width:300px"><div class="hstack"><div class="eyebrow grow">Profiles</div>' + UI.btn('New', { size: 'sm', attrs: 'data-new' }) + '</div><div class="vstack gap4">'
        + list.map((x) => UI.listItem(esc(x.id), esc(x.alias ? 'alias, points to ' + resolve(st, x).id : x.sub), { active: x.id === p.id, attrs: 'data-profile="' + esc(x.id) + '"', right: UI.pill(x.status, x.status === 'alias' ? '' : undefined) })).join('') + '</div></div>';

      let main;
      if (isAlias) {
        const targets = PROFILES.filter((x) => !x.alias);
        main = UI.pagehead(p.id, UI.pill('alias') + ' Clients ask for <span class="mono">' + esc(p.id) + '</span>; the gateway resolves it to a profile you can repoint without client changes', UI.btn('Repoint alias', { kind: 'primary', attrs: 'data-repoint' }))
          + '<div class="formgrid" style="--cols:3">' + UI.field('Points to', UI.select(targets.map((x) => x.id), target.id, 'data-alias-target')) + UI.field('Resolved model', UI.input(target.model, { readonly: true })) + UI.field('Resolved ceiling', '<div style="height:30px;display:flex;align-items:center">' + UI.label(target.maxLabel) + '</div>') + '</div>'
          + UI.panel('Workspaces using this alias', UI.table(['Workspace', 'Label', 'Usage', 'Effect of ' + target.id], WORKSPACES.map((w) => [esc(w.name), UI.label(w.label, { sm: true }), esc(w.conv), LEVELS[w.label] <= LEVELS[target.maxLabel] ? UI.pill('within ceiling', 'ok') : UI.pill('above ceiling', 'danger')]), { clickable: false, minWidth: '0' }))
          + UI.panel('Resolved profile', UI.kv([['Profile', '<a href="#" data-profile-link="' + esc(target.id) + '">' + esc(target.id) + '</a>'], ['Pool', '<a href="#" data-go="pools">' + esc(target.pool) + '</a>'], ['Residency', esc(target.residency)], ['Think', esc(target.think)], ['MCP bindings', bindings.length + ' servers, ' + toolCount + ' tools'], ['Fallback', esc(target.fallback)]], 3));
      } else {
        const pointerBar = '<div class="profiles-ptr"><div class="stable" style="width:' + (100 - ptr.pct) + '%"></div>' + (ptr.pct ? '<div class="canary" style="width:' + ptr.pct + '%"></div>' : '') + '</div>';
        const ptrText = ptr.pct ? (100 - ptr.pct) + '% on ' + esc(ptr.stable) + ', ' + ptr.pct + '% canary on ' + esc(ptr.canary) : '100% on ' + esc(ptr.stable) + (ptr.previous ? ', ' + esc(ptr.previous) + ' stays warm for 24 h' : '');
        const bindRows = bindings.map((b) => ({ cells: [esc(b.server) + (b.builtin ? ' ' + UI.pill('built-in') : ''), (b.builtin ? esc(b.tools) : '<span class="mono fg2">' + esc(b.tools) + '</span>') + (b.disabled ? ' ' + UI.pill(b.disabled, 'danger') : ''), esc(b.confirm), UI.label(b.ceiling, { sm: true })], attrs: 'data-binding="' + esc(b.server) + '"' }));
        if (overBudget) bindRows.push({ cells: ['erp-sap', 'all 3 tools', 'on write', UI.label('confidential', { sm: true })], attrs: 'data-binding="erp-sap"' }, { cells: ['browser-sandbox ' + UI.pill('per-session'), 'all 3 tools', 'always', UI.label('internal', { sm: true })], attrs: 'data-binding="browser-sandbox"' }, { cells: ['jira-internal ' + UI.pill('extended'), 'all 18 project tools', 'on write', UI.label('confidential', { sm: true })], attrs: 'data-binding="jira-internal"' });
        main = UI.pagehead(p.id, UI.pill(p.status) + ' What users pick in chat: a pinned model version plus options, prompt, pool, residency, ceiling and tools', UI.btn('Preview effective tools for a user', { attrs: 'data-preview' }) + UI.btn('Save draft', { kind: 'primary', attrs: 'data-save' }))
          + (p.note ? UI.notice(esc(p.note) + ' <a href="#" data-go="models">Open Models</a>', 'info') : '')
          + (p.noTools ? UI.notice('<b>Binding refused.</b> nomic-embed-text lacks the tools capability, so the registry rejects any MCP binding on this profile. <a href="#" data-go="models">See the model</a>', 'danger') : '')
          + '<div class="formgrid" style="--cols:3">'
          + UI.field('Model version', UI.select([target.model + ', ' + target.stable.replace('..', '..')].concat(ptr.canary ? [target.model + ', ' + ptr.canary + ' (canary)'] : []), target.model + ', ' + target.stable, 'data-f="model"'), '<a href="#" data-go="models">Open in Models</a>')
          + UI.field('Pool', UI.select(['gpu-large', 'cpu-helpers', 'gpu-amd', 'mac-overflow'], f.pool, 'data-f="pool"'), '<a href="#" data-go="pools">Instances and health</a>')
          + UI.field('Residency', UI.select(['pinned', 'warm', 'on-demand', 'batch-only'], f.residency, 'data-f="residency"'))
          + UI.field('num_ctx (fixed at load)', UI.input(f.num_ctx, { attrs: 'data-f="num_ctx" class="input mono"' }).replace('class="input" ', ''), 'Changing it reloads the model on every instance')
          + UI.field('temperature', UI.input(f.temperature, { attrs: 'data-f="temperature" class="input mono"' }).replace('class="input" ', ''))
          + UI.field('Max label', UI.select(['public', 'internal', 'confidential', 'restricted'], f.maxLabel, 'data-f="maxLabel"'))
          + UI.field('System prompt', UI.select(['prompts/analyst, v4', 'prompts/analyst, v3', 'prompts/general, v2', 'prompts/coder, v1', 'prompts/vision, v1', 'none'], f.prompt, 'data-f="prompt"'))
          + UI.field('Think', UI.select(['off', 'low, users may choose up to medium', 'medium, users may choose up to high', 'high, users may choose up to high'], f.think, 'data-f="think"'))
          + UI.field('Fallback chain', UI.select(['none', 'general-8b after 8 s queue wait', 'general-8b after 10 s queue wait', 'fast after 5 s queue wait', 'analyst after 8 s queue wait'], f.fallback, 'data-f="fallback"'))
          + '</div>'
          + UI.panel('Version pointer', '<div class="hstack wrap gap12"><div style="flex:1 1 200px">' + pointerBar + '</div><span class="fg2" style="font-size:12px">' + ptrText + '</span>' + UI.btn('Promote', { size: 'sm', attrs: 'data-promote', disabled: !ptr.pct }) + UI.btn('Roll back', { size: 'sm', attrs: 'data-rollback', disabled: !ptr.pct && !ptr.previous }) + '</div>')
          + '<div class="cols"><div class="grow vstack gap12" style="min-width:0">'
          + UI.panel('MCP bindings', (st.bindRefused && p.noTools ? '' : '')
            + UI.table(['MCP server', 'Tools exposed', 'Confirm', 'Ceiling'], bindRows, { minWidth: '0', emptyTitle: p.noTools ? 'No bindings possible' : 'No servers bound', emptyText: p.noTools ? 'The model has no tools capability.' : 'Bind a server to expose tools through this profile.' })
            + (overBudget ? UI.notice('31 tools are bound against a budget of 24. The profile exposes <span class="mono">find_tools</span> instead and loads matches per step from the tool description index.', 'warn', UI.btn('Raise budget', { size: 'sm', attrs: 'data-raise' })) : '')
            + '<div class="grid2">' + UI.meter('Tools', toolCount + ' of ' + target.maxTools, target.maxTools ? (toolCount / target.maxTools) * 100 : 0, toolCount > target.maxTools ? 'danger' : '') + UI.meter('Schema tokens', schemaUsed.toLocaleString('en-GB') + ' of ' + target.maxSchema.toLocaleString('en-GB'), target.maxSchema ? (schemaUsed / target.maxSchema) * 100 : 0, schemaUsed > target.maxSchema ? 'danger' : '') + '</div>', { actions: UI.btn('Bind server', { size: 'sm', attrs: 'data-bind', disabled: !!p.noTools, title: p.noTools ? 'Model has no tools capability' : '' }) })
          + '</div><div style="width:330px;flex-shrink:0">' + UI.panel('YAML', '<pre class="profiles-yaml">' + esc(yaml) + '</pre>', { actions: UI.btn('Copy', { kind: 'ghost', size: 'xs', attrs: 'data-copy="profile yaml"' }) }) + '</div></div>';
      }

      root.innerHTML = '<style>'
        + '.profiles-ptr{display:flex;height:12px;background:var(--sel);border-radius:3px;overflow:hidden}.profiles-ptr .stable{background:var(--meter)}.profiles-ptr .canary{background:var(--accent)}'
        + '.profiles-yaml{margin:0;padding:10px 12px;background:var(--panel2);border:1px solid var(--line);border-radius:6px;font-family:var(--mono);font-size:12px;line-height:1.5;white-space:pre;overflow:auto;min-height:210px}'
        + '</style>'
        + sideList
        + '<div class="page">' + main + '<div><div class="eyebrow" style="margin-bottom:8px">States to design from this page</div>' + UI.states(this.states) + '</div></div>';

      // ---- events ----
      ctx.on('click', '[data-profile]', (e, t) => { st.selected = t.dataset.profile; ctx.rerender(); });
      ctx.on('click', '[data-profile-link]', (e, t) => { e.preventDefault(); st.selected = t.dataset.profileLink; ctx.rerender(); });
      ctx.on('click', '[data-go]', (e, t) => { e.preventDefault(); ctx.navigate(t.dataset.go, t.dataset.go === 'models' ? { model: target.model } : undefined); });
      ctx.on('change', '[data-f]', (e, t) => { st.form[target.id] = st.form[target.id] || {}; st.form[target.id][t.dataset.f] = t.value; st.dirty = true; ctx.rerender(); });
      ctx.on('click', '[data-save]', () => { st.dirty = false; ctx.toast('Draft saved for <b>' + esc(p.id) + '</b>. The published version keeps serving until a model admin publishes the draft.', 'ok', 5000); });
      ctx.on('click', '.state-card', (e, t) => ctx.app.applyState(+t.dataset.state));
      ctx.on('click', '[data-raise]', () => ctx.modal({ title: 'Raise tool budget for analyst', body: UI.field('maxTools', UI.input('32', { attrs: 'class="input mono"' }).replace('class="input" ', '')) + UI.field('maxSchemaTokens', UI.input('9000', { attrs: 'class="input mono"' }).replace('class="input" ', '')) + UI.notice('A 32B model keeps tool-calling accuracy up to about 30 tools in the conformance suite. Above that, find_tools stays the safer choice.', 'warn'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save to draft', { kind: 'primary', attrs: 'data-close data-ok' }), onMount(m) { m.querySelector('[data-ok]').addEventListener('click', () => { st.overBudget = false; target.maxTools = 32; target.maxSchema = 9000; ctx.rerender(); ctx.toast('Budget raised to 32 tools, 9,000 schema tokens in the draft.', 'ok'); }); } }));

      ctx.on('click', '[data-promote]', async () => {
        const ok = await ctx.confirm({ title: 'Promote canary on ' + p.id, tag: 'blue/green', tone: 'info', body: '<p style="margin:0" class="fg2">The pointer flips to ' + esc(ptr.canary) + ' for 100% of traffic. In-flight streams finish on ' + esc(ptr.stable) + ', which stays warm for 24 hours so a rollback is instant.</p>', kv: [['Canary traffic so far', ptr.pct + '%, 1,842 turns'], ['Guardrail triggers', 'canary 0.4%, stable 0.4%'], ['First token p50', 'canary 1.3 s, stable 1.1 s'], ['Flags', '0 on canary']], ok: 'Promote' });
        if (!ok) return;
        st.pointer[target.id] = { stable: ptr.canary, canary: null, pct: 0, previous: ptr.stable }; ctx.rerender(); ctx.toast('<b>' + esc(p.id) + '</b> now serves 100% on ' + esc(ptr.canary) + '. Previous version stays warm for 24 h.', 'ok', 5000);
      });
      ctx.on('click', '[data-rollback]', async () => {
        const back = ptr.previous || ptr.stable;
        const ok = await ctx.confirm({ title: 'Roll back ' + p.id, tag: 'rollback', tone: 'warn', body: '<p style="margin:0" class="fg2">The pointer moves back to ' + esc(back) + ' for all traffic and the canary unloads with keep_alive 0 once its streams finish.</p>', ok: 'Roll back' });
        if (!ok) return;
        st.pointer[target.id] = { stable: back, canary: null, pct: 0 }; ctx.rerender(); ctx.toast('Rolled back. 100% on ' + esc(back) + '.', 'warn');
      });

      ctx.on('click', 'tr.row[data-binding]', (e, t) => {
        const b = bindings.find((x) => x.server === t.dataset.binding) || { server: t.dataset.binding, tools: 'all tools', confirm: 'on write', ceiling: 'confidential', n: 3 };
        const srv = SERVERS.find((s) => s.id === b.server) || SERVERS[0];
        ctx.drawer({ title: esc(b.server) + ' on ' + esc(p.id), body: (b.disabled ? UI.notice('<b>Disabled.</b> The server announced tools/list_changed and the schema hash for <span class="mono">create_merge_request</span> no longer matches the approved hash. The tool stays off until a tool admin re-reviews it.', 'danger') : '') + UI.kv([['Hosting', esc(srv.mode)], ['Server ceiling', UI.label(srv.ceiling, { sm: true })], ['Profile ceiling', UI.label(target.maxLabel, { sm: true })], ['Schema hash', '<span class="mono">' + (b.disabled ? 'e91a… changed' : '4f0c… approved') + '</span>']], 2) + '<div class="eyebrow">Tools exposed</div><div class="vstack gap4">' + srv.tools.map((tl) => UI.check(tl, b.builtin || b.tools.includes(tl) || /^all/.test(b.tools))).join('') + '</div>' + UI.field('Confirm', UI.select(['never', 'on write', 'always'], b.confirm)) + UI.notice('Acts as the user through this profile. Side-effect classes come from the tool admin review, not from the server\'s annotations.', 'info'), actions: (b.disabled ? UI.btn('Re-review in MCP servers', { kind: 'primary', attrs: 'data-close data-mcp' }) : UI.btn('Save to draft', { kind: 'primary', attrs: 'data-close data-savebind' })) + UI.btn('Unbind', { kind: 'danger', attrs: 'data-close data-unbind' }) + UI.btn('Close', { kind: 'ghost', attrs: 'data-close' }), onMount(d) { const m = d.querySelector('[data-mcp]'); if (m) m.addEventListener('click', () => ctx.navigate('mcp-servers', { server: b.server })); const s = d.querySelector('[data-savebind]'); if (s) s.addEventListener('click', () => ctx.toast('Binding saved to the draft.', 'ok')); d.querySelector('[data-unbind]').addEventListener('click', () => { st.unbound[target.id] = st.unbound[target.id] || {}; st.unbound[target.id][b.server] = true; ctx.rerender(); ctx.toast(esc(b.server) + ' unbound from ' + esc(p.id) + ' in the draft.'); }); } });
      });

      const bindModal = (preset) => {
        const draw = (sid) => {
          const srv = SERVERS.find((s) => s.id === sid);
          const conflict = LEVELS[srv.ceiling] > LEVELS[target.maxLabel];
          return UI.field('MCP server', UI.select(SERVERS.map((s) => ({ value: s.id, label: s.id + ', ' + s.mode + ', ceiling ' + s.ceiling })), sid, 'data-srv'))
            + (conflict ? UI.notice('<b>Ceiling conflict.</b> ' + esc(srv.id) + ' reaches ' + esc(srv.ceiling) + ' data; this profile is capped at ' + esc(target.maxLabel) + '. Raise the profile ceiling or pick a server within it.', 'danger') : '')
            + '<div class="eyebrow">Tools to expose</div><div class="vstack gap4">' + srv.tools.map((tl) => UI.check(tl, true)).join('') + '</div>'
            + UI.field('Confirm', UI.select(['never', 'on write', 'always'], 'on write'))
            + UI.notice('Budget after binding: ' + (toolCount + srv.tools.length) + ' of ' + target.maxTools + ' tools. Schemas are hashed at approval; a later change disables the tool until re-review.', (toolCount + srv.tools.length) > target.maxTools ? 'warn' : 'info')
            + '<div class="mfoot">' + UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Bind', { kind: 'primary', attrs: 'data-dobind', disabled: conflict }) + '</div>';
        };
        ctx.modal({ title: 'Bind server to ' + esc(p.id), body: '<div class="vstack gap12" id="bindbody">' + draw(preset) + '</div>', onMount(m) {
          const host = m.querySelector('#bindbody');
          const wire = () => {
            host.querySelector('[data-srv]').addEventListener('change', (e) => { host.innerHTML = draw(e.target.value); wire(); });
            host.querySelector('[data-dobind]').addEventListener('click', () => { const sid = host.querySelector('[data-srv]').value; const srv = SERVERS.find((s) => s.id === sid); App.closeOverlay(); st.extraBindings[target.id] = st.extraBindings[target.id] || []; st.extraBindings[target.id].push({ server: sid, tools: srv.tools.join(', '), n: srv.tools.length, confirm: 'on write', ceiling: srv.ceiling, added: true }); ctx.rerender(); ctx.toast(esc(sid) + ' bound to ' + esc(p.id) + ' in the draft. Tokens are audience-bound to that server.', 'ok', 5000); });
          };
          wire();
        } });
      };
      ctx.on('click', '[data-bind]', () => bindModal('erp-sap'));
      if (st.openBind) { const s = st.openBind; st.openBind = null; setTimeout(() => bindModal(s), 30); }

      const repointModal = (to) => {
        const draw = (tid) => {
          const tp = PROFILES.find((x) => x.id === tid);
          return UI.field('Point ' + esc(p.id) + ' to', UI.select(PROFILES.filter((x) => !x.alias).map((x) => x.id), tid, 'data-to'))
            + UI.kv([['From', esc(target.id) + ', ' + esc(target.model)], ['To', esc(tp.id) + ', ' + esc(tp.model)], ['Ceiling', esc(target.maxLabel) + ' → ' + esc(tp.maxLabel)], ['Pool', esc(target.pool) + ' → ' + esc(tp.pool)]], 2)
            + '<div class="eyebrow">Affected workspaces</div>' + UI.table(['Workspace', 'Label', 'Usage', 'Effect'], WORKSPACES.map((w) => [esc(w.name), UI.label(w.label, { sm: true }), esc(w.conv), tp.id === 'analyst' && w.label !== 'confidential' ? '<span style="color:var(--warn-fg)">users below confidential clearance lose this alias</span>' : 'history re-rendered with the new template']), { clickable: false, minWidth: '0' })
            + UI.notice('Applies atomically. In-flight streams finish on ' + esc(target.id) + '. Clients keep asking for ' + esc(p.id) + ' and see the change on their next turn.', 'info')
            + '<div class="mfoot">' + UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Apply repoint', { kind: 'primary', attrs: 'data-apply' }) + '</div>';
        };
        ctx.modal({ title: 'Repoint alias ' + esc(p.id), cls: 'wide', body: '<div class="vstack gap12" id="rpbody">' + draw(to) + '</div>', onMount(m) {
          const host = m.querySelector('#rpbody');
          const wire = () => {
            host.querySelector('[data-to]').addEventListener('change', (e) => { host.innerHTML = draw(e.target.value); wire(); });
            host.querySelector('[data-apply]').addEventListener('click', () => { const tid = host.querySelector('[data-to]').value; App.closeOverlay(); st.aliasTarget[p.id] = tid; ctx.rerender(); ctx.toast('<b>' + esc(p.id) + '</b> now points to <b>' + esc(tid) + '</b>. 3 workspaces notified.', 'ok', 5000); });
          };
          wire();
        } });
      };
      ctx.on('click', '[data-repoint]', () => repointModal(target.id === 'general-8b' ? 'analyst' : 'general-8b'));
      ctx.on('change', '[data-alias-target]', (e, t) => repointModal(t.value));
      if (st.openRepoint) { const to = st.openRepoint; st.openRepoint = null; setTimeout(() => repointModal(to), 30); }

      ctx.on('click', '[data-preview]', () => {
        const rows = [['kb-search.search', 'kb-search', UI.pill('included', 'ok'), 'built-in, workspace enabled'], ['kb-search.get_passage', 'kb-search', UI.pill('included', 'ok'), 'built-in'], ['jira-internal.search_issues', 'jira-internal', UI.pill('included', 'ok'), 'scope jira:read'], ['jira-internal.get_issue', 'jira-internal', UI.pill('included', 'ok'), 'scope jira:read'], ['jira-internal.create_issue', 'jira-internal', UI.pill('included, confirm', 'warn'), 'scope jira:write, confirm on write'], ['gitlab-onprem.create_merge_request', 'gitlab-onprem', UI.pill('excluded', 'danger'), 'disabled, schema changed']];
        ctx.modal({ title: 'Effective tools for a user on ' + esc(p.id), cls: 'wide', body: '<div class="formgrid" style="--cols:2">' + UI.field('User', UI.select(['Mara Okafor, mokafor', 'Sam Reyes, sreyes'], 'Mara Okafor, mokafor')) + UI.field('Workspace', UI.select(['Finance Ops, confidential', 'People Ops, internal', 'Field Sales, internal'], 'Finance Ops, confidential')) + '</div>' + UI.table(['Tool', 'Server', 'Result', 'Reason'], rows, { clickable: false, minWidth: '0' }) + '<div class="muted" style="font-size:12px">Effective set = profile bindings ∩ workspace enablement ∩ agent allow-list ∩ user scopes, then filtered by label ceilings and tool egress. Computed per turn, cached by policy version 214.</div>', actions: UI.btn('Close', { attrs: 'data-close' }) });
      });

      const newModal = () => ctx.modal({ title: 'New model profile', body: '<div class="formgrid" style="--cols:2">' + UI.field('Name', UI.input('', { placeholder: 'summariser-8b', attrs: 'data-n' })) + UI.field('Model version', UI.select(['qwen2.5:32b-q4_K_M, sha256:41ab..', 'llama3.1:8b-q5_K_M, sha256:7d21..', 'llama3.2:3b-q8_0, sha256:3c8a..'], 'llama3.1:8b-q5_K_M, sha256:7d21..', 'data-m')) + UI.field('Pool', UI.select(['gpu-large', 'cpu-helpers'], 'gpu-large')) + UI.field('Residency', UI.select(['pinned', 'warm', 'on-demand', 'batch-only'], 'on-demand')) + UI.field('Max label', UI.select(['public', 'internal', 'confidential', 'restricted'], 'internal', 'data-l')) + UI.field('Hardware classes', UI.input('cuda, rocm')) + '</div>' + UI.notice('Only approved model versions are offered. The profile starts as a draft and goes through review before users can pick it.', 'info'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Create draft', { kind: 'primary', attrs: 'data-create' }), onMount(m) { m.querySelector('[data-create]').addEventListener('click', () => { const name = (m.querySelector('[data-n]').value || 'summariser-8b').trim(); const model = m.querySelector('[data-m]').value.split(', ')[0]; const lbl = m.querySelector('[data-l]').value; App.closeOverlay(); st.created.push({ id: name, model, short: model.split(':')[0], sub: model.split('-q')[0], status: 'draft', maxLabel: lbl, pool: 'gpu-large', residency: 'on-demand', num_ctx: '8192', temperature: '0.5', prompt: 'none', promptKey: 'none', think: 'off', thinkKey: '{ default: off, ceiling: off }', fallback: 'none', fallbackKey: 'none', stable: 'sha256:7d21..', canary: null, canaryPct: 0, maxTools: 12, maxSchema: 3000, schemaUsed: 0, bindings: [] }); st.selected = name; ctx.rerender(); ctx.toast('Draft profile <b>' + esc(name) + '</b> created.', 'ok'); }); } });
      ctx.on('click', '[data-new]', newModal);
      if (st.openNew) { st.openNew = false; setTimeout(newModal, 30); }
    }
  });
})();
