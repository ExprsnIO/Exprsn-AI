// Apps, the Flows tab (the exprsn-platform low-code port, docs/decisions/lowcode-port.md): an app's automations on a
// canvas of trigger, condition and actions, with a node inspector and a condition builder. A flow is saved to
// /api/apps/:app/flows, where the server compiles it into a Workflows graph, publishes it and keeps its trigger.
// `apps.js` calls App.appsFlows(ctx, app, deps) for the tab's body and inspector; the state lives in ctx.state.
(function () {
  const { UI, esc } = App;
  const enc = encodeURIComponent;
  const EVENTS = ['created', 'updated', 'deleted', 'transitioned'];
  const LEAF_OPS = [
    { value: 'eq', label: 'equals' }, { value: 'ne', label: 'does not equal' }, { value: 'gt', label: 'greater than' }, { value: 'gte', label: 'at least' },
    { value: 'lt', label: 'less than' }, { value: 'lte', label: 'at most' }, { value: 'contains', label: 'contains' }, { value: 'not_contains', label: 'does not contain' },
    { value: 'exists', label: 'is set' }, { value: 'not_exists', label: 'is not set' }, { value: 'truthy', label: 'is true' }, { value: 'falsy', label: 'is false' },
    { value: 'in', label: 'is one of' }, { value: 'not_in', label: 'is none of' }
  ];
  const NO_VALUE = ['exists', 'not_exists', 'truthy', 'falsy'];
  const LIST_VALUE = ['in', 'not_in'];
  const GROUPS = [{ value: 'all', label: 'all of these match' }, { value: 'any', label: 'any of these match' }, { value: 'none', label: 'none of these match' }];
  const TYPES = [{ value: 'update', label: 'Update a record' }, { value: 'transition', label: 'Move a record to a state' }, { value: 'create', label: 'Create a record' }, { value: 'notify', label: 'Send a notice' }, { value: 'message', label: 'Send a message' }, { value: 'approval', label: 'Ask for an approval' }, { value: 'wait', label: 'Wait' },
    { value: 'ai', label: 'AI step' }, { value: 'agent', label: 'Ask an agent' }, { value: 'tool', label: 'Run a tool' }, { value: 'script', label: 'Run a script' }, { value: 'http', label: 'HTTP request' }, { value: 'decision', label: 'Decide with a table' }];
  // What each action gives later actions, as {{steps.act<N>.<field>}} (the compiled step's output).
  const OUTPUTS = { create: ['id', 'state', 'values'], update: ['id', 'state', 'values'], transition: ['id', 'state', 'values'], notify: ['notified', 'skipped'], approval: ['approved', 'by'], wait: [], ai: ['text'], agent: ['text', 'run'], tool: [], script: [], message: ['conversation', 'message'], http: ['status', 'body'], decision: ['matched'] };
  // Where a registry tool comes from, for the grouped picker (as on Workflows).
  const TOOL_SOURCES = [['builtin', 'Built-in'], ['registry', 'Registry'], ['mcp', 'MCP servers'], ['script', 'Scripts']];
  const toolSource = (t) => (t.impl === 'builtin' || t.impl === 'mcp' || t.impl === 'script' ? t.impl : 'registry');
  const toolHit = (t, needle) => !needle || (t.name + ' ' + (t.description || '')).toLowerCase().indexOf(needle) >= 0;
  function toolOptions(tools, val, q) {
    const needle = String(q || '').trim().toLowerCase();
    let html = val ? '' : '<option value="" selected>choose a tool</option>';
    if (val && !tools.some((t) => t.name === val)) html += '<option value="' + esc(val) + '" selected>' + esc(val) + ' (not published here)</option>';
    TOOL_SOURCES.forEach((g) => {
      const list = tools.filter((t) => toolSource(t) === g[0] && (t.name === val || toolHit(t, needle)));
      if (list.length) html += '<optgroup label="' + esc(g[1]) + '">' + list.map((t) => '<option value="' + esc(t.name) + '"' + (t.name === val ? ' selected' : '') + '>' + esc(t.name + ' · ' + t.sideEffect + (t.needsApproval ? ' · needs an approval first' : '') + (t.fits ? '' : ' · below this label')) + '</option>').join('') + '</optgroup>';
    });
    return html;
  }
  const toolCount = (tools, q) => { const needle = String(q || '').trim().toLowerCase(); const hit = tools.filter((t) => toolHit(t, needle)); return hit.length + ' of ' + tools.length + ' tools'; };
  const lines = (obj) => Object.keys(obj || {}).map((k) => k + ': ' + obj[k]).join('\n');
  const unlines = (text) => { const o = {}; String(text).split('\n').forEach((l) => { const i = l.indexOf(':'); if (i > 0) { const k = l.slice(0, i).trim(); if (k) o[k] = l.slice(i + 1).trim(); } }); return o; };
  const typeLabel = (t) => (TYPES.find((x) => x.value === t) || { label: t }).label;
  const opLabel = (o) => (LEAF_OPS.find((x) => x.value === o) || { label: o }).label;
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const CSS = '#main .lcf-canvas{display:flex;flex-direction:column;align-items:stretch;gap:0;padding:12px;border:1px dashed var(--line2);border-radius:8px;background:var(--panel2);min-width:0}'
    + '#main .lcf-node{display:block;width:100%;max-width:460px;text-align:left;border:1px solid var(--line2);border-left:4px solid var(--accent);border-radius:8px;background:var(--panel);padding:8px 12px;color:var(--fg);font:inherit;cursor:pointer;min-width:0}'
    + '#main .lcf-node:focus-visible{outline:2px solid var(--accent);outline-offset:2px}#main .lcf-node[aria-pressed="true"]{background:var(--sel);box-shadow:0 0 0 2px var(--accent)}'
    + '#main .lcf-node.k-trigger{border-left-color:var(--info-fg)}#main .lcf-node.k-condition{border-left-color:var(--warn-fg)}#main .lcf-node.k-action{border-left-color:var(--ok-fg)}#main .lcf-node.k-end{border-left-color:var(--muted);cursor:default}'
    + '#main .lcf-badge{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--fg2)}#main .lcf-title{font-weight:600;overflow-wrap:anywhere}#main .lcf-sub{font-size:12px;color:var(--fg2);overflow-wrap:anywhere}'
    + '#main .lcf-arrow{width:2px;height:22px;background:var(--line2);margin-left:22px;position:relative}#main .lcf-arrow::after{content:"";position:absolute;left:-4px;bottom:-1px;border:5px solid transparent;border-top-color:var(--line2);border-bottom:0}'
    + '#main .lcf-cond{border-left:2px solid var(--line2);padding:4px 0 4px 10px;display:flex;flex-direction:column;gap:6px;min-width:0}#main .lcf-leaf{display:flex;flex-wrap:wrap;gap:6px;align-items:flex-end;min-width:0}#main .lcf-leaf > *{min-width:0}'
    + '#main .lcf-val{display:flex;gap:6px;align-items:flex-end;flex-wrap:wrap}#main .lcf-graph{display:block;max-width:100%;height:auto}#main .lcf-graph rect{fill:var(--panel);stroke:var(--line2)}#main .lcf-graph text{font:500 10px var(--sans);fill:var(--fg)}'
    + '#main .lcf-graph .e{stroke:var(--fg2);fill:none}#main .lcf-graph .f{stroke:var(--danger-fg);stroke-dasharray:4 3;fill:none}#main .lcf-graph .bl{fill:var(--fg2);font-size:9px}';

  const isGroup = (c) => !!c && (Array.isArray(c.all) || Array.isArray(c.any) || Array.isArray(c.none));
  const gop = (g) => (Array.isArray(g.all) ? 'all' : Array.isArray(g.any) ? 'any' : 'none');
  const kids = (g) => g[gop(g)];
  const leafText = (l) => l.field + ' ' + opLabel(l.op) + (l.value === undefined || l.value === null ? '' : ' ' + (Array.isArray(l.value) ? l.value.join(', ') : String(l.value)));
  const condText = (c) => (!c ? 'always' : isGroup(c) ? (kids(c).length ? gop(c) + ' of ' + kids(c).length : 'always') : leafText(c));
  const leafCount = (c) => (!c ? 0 : isGroup(c) ? kids(c).reduce((a, x) => a + leafCount(x), 0) : 1);

  function emptyFlow(app) {
    const ent = app.entities[0];
    return { key: 'new', name: '', title: '', entity: ent ? ent.name : '', trigger: { kind: 'record', events: ['created'] }, enabled: true, match: null, actions: [{ type: 'update', values: {} }], dirty: true };
  }
  function fromView(f) {
    return { key: f.id, id: f.id, name: f.name, title: f.title || '', entity: f.entity, trigger: clone(f.trigger), enabled: f.enabled, match: f.match ? clone(f.match) : null, actions: clone(f.actions || []), workflowId: f.workflowId, workflow: f.workflow, editedElsewhere: f.editedElsewhere, graph: f.graph, hook: f.hook || null, updatedAt: f.updatedAt, dirty: false };
  }
  function newAction(type, app, fd) {
    const ent = app.entities.find((e) => e.name === fd.entity);
    const sm = ent && ent.definition && ent.definition.states;
    if (type === 'create') return { type, entity: app.entities[0] ? app.entities[0].name : fd.entity, values: {} };
    if (type === 'transition') return { type, to: sm ? sm.states[0].name : '' };
    if (type === 'notify') return { type, roles: ['workflow-admin'], users: [], title: 'Flow ' + (fd.name || 'notice'), body: '' };
    if (type === 'approval') return { type, role: 'workflow-admin', show: '', timeoutHours: 24 };
    if (type === 'wait') return { type, minutes: 60 };
    const pal = fd.pal || {};
    if (type === 'tool') return { type, tool: '', args: {} };
    if (type === 'script') { const sc = (pal.scripts || []).find((x) => x.reviewed || (x.versions || []).length); return { type, script: sc ? sc.name : '', args: {} }; }
    if (type === 'agent') return { type, agent: ((pal.agents || [])[0] || {}).name || '', input: 'Look at {{input.record.values.' + ((ent && ent.definition.fields[0] && ent.definition.fields[0].name) || 'title') + '}}' };
    if (type === 'ai') return { type, profile: ((pal.profiles || [])[0] || {}).name || '', prompt: '', format: 'text' };
    if (type === 'message') return { type, user: '', body: '' };
    if (type === 'http') return { type, method: 'POST', url: 'https://', headers: { 'Content-Type': 'application/json' }, body: '' };
    if (type === 'decision') { const t = (pal.decisions || []).find((x) => x.fits) || (pal.decisions || [])[0]; return { type, table: t ? t.name : '', inputs: {}, noMatch: 'continue' }; }
    return { type: 'update', values: {} };
  }
  // The payload the API takes: empty optional parts left out.
  function payload(fd, isNew) {
    const actions = fd.actions.map((a) => {
      const o = clone(a);
      ['title', 'record', 'entity', 'show', 'body', 'user', 'conversation', 'version'].forEach((k) => { if (o[k] === '' || o[k] == null) delete o[k]; });
      if (o.type === 'message' && o.body == null) o.body = '';
      if (o.query && !Object.keys(o.query).length) delete o.query;
      if (!o.when) delete o.when;
      if (o.onError === 'stop') delete o.onError;
      if (!o.retries) delete o.retries;
      return o;
    });
    const body = { entity: fd.entity, trigger: fd.trigger.kind === 'record' ? { kind: 'record', events: fd.trigger.events } : fd.trigger.kind === 'schedule' ? { kind: 'schedule', cron: fd.trigger.cron || '' } : fd.trigger.kind === 'webhook' ? { kind: 'webhook' } : { kind: 'manual' }, enabled: fd.enabled, match: fd.match || null, actions };
    if (fd.title) body.title = fd.title;
    if (isNew) body.name = fd.name;
    return body;
  }

  // ---------- the condition builder ----------
  // A tree of groups (all, any, none) and comparisons, addressed by a path of child indices; `pfx` names the tree
  // (`match`, or `when:<action index>`).
  function fieldOptions(ent, triggerKind) {
    const fields = ((ent && ent.definition && ent.definition.fields) || []).filter((f) => f.type !== 'json').map((f) => ({ value: f.name, label: f.title ? f.title + ' (' + f.name + ')' : f.name }));
    const sys = [];
    if (ent && ent.definition && ent.definition.states) sys.push({ value: 'state', label: 'state of the record' });
    sys.push({ value: 'label', label: 'label of the record' }, { value: 'event', label: 'event (created, updated…)' });
    if (triggerKind === 'record') sys.push({ value: 'from', label: 'from state (transitioned)' }, { value: 'to', label: 'to state (transitioned)' });
    return fields.concat(sys);
  }
  function leafHtml(l, pfx, path, opts, label) {
    const k = pfx + '|' + path;
    const needs = NO_VALUE.indexOf(l.op) < 0;
    const val = l.value === undefined || l.value === null ? '' : Array.isArray(l.value) ? l.value.join(', ') : String(l.value);
    return '<div class="lcf-leaf" role="group" aria-label="' + esc(label) + '">'
      + UI.field('Field', UI.select(opts.concat(opts.some((o) => o.value === l.field) ? [] : [{ value: l.field, label: l.field + ' (unknown)' }]), l.field, 'data-cf="' + esc(k) + '"'))
      + UI.field('Test', UI.select(LEAF_OPS, l.op, 'data-co="' + esc(k) + '"'))
      + (needs ? UI.field(LIST_VALUE.indexOf(l.op) >= 0 ? 'Values, comma-separated' : 'Value', UI.input(val, { attrs: 'data-cv="' + esc(k) + '"' })) : '')
      + UI.iconbtn('trash', 'Remove the comparison ' + leafText(l), { attrs: 'data-cdel="' + esc(k) + '"', cls: 'sm ghost' }) + '</div>';
  }
  function condHtml(c, pfx, path, opts, depth) {
    const k = pfx + '|' + path;
    if (!isGroup(c)) return leafHtml(c, pfx, path, opts, 'Comparison ' + (path || '1'));
    const list = kids(c);
    return '<div class="lcf-cond" role="group" aria-label="Group: ' + esc(gop(c)) + '">'
      + UI.field('Match when', UI.select(GROUPS, gop(c), 'data-cg="' + esc(k) + '"'))
      + list.map((x, i) => condHtml(x, pfx, path === '' ? String(i) : path + '.' + i, opts, depth + 1)).join('')
      + '<div class="hstack wrap gap6">' + UI.btn('Add comparison', { size: 'xs', icon: 'plus', attrs: 'data-cadd="' + esc(k) + '"' }) + (depth < 3 ? UI.btn('Add group', { size: 'xs', icon: 'plus', attrs: 'data-caddg="' + esc(k) + '"' }) : '') + (path !== '' ? UI.btn('Remove group', { size: 'xs', kind: 'ghost', attrs: 'data-cdel="' + esc(k) + '"' }) : '') + '</div></div>';
  }
  function builderHtml(root, pfx, opts, emptyText) {
    if (!root) return '<div class="muted" style="font-size:12px">' + esc(emptyText) + '</div><div class="hstack wrap gap6">' + UI.btn('Add comparison', { size: 'xs', icon: 'plus', attrs: 'data-cadd="' + esc(pfx) + '|"' }) + UI.btn('Add group', { size: 'xs', icon: 'plus', attrs: 'data-caddg="' + esc(pfx) + '|"' }) + '</div>';
    return condHtml(root, pfx, '', opts, 0) + (isGroup(root) ? '' : '<div class="hstack wrap gap6">' + UI.btn('Add another comparison', { size: 'xs', icon: 'plus', attrs: 'data-cadd="' + esc(pfx) + '|"' }) + '</div>') + '<div class="muted" style="font-size:12px">' + leafCount(root) + ' comparison' + (leafCount(root) === 1 ? '' : 's') + '; each becomes one branch step of the workflow.</div>';
  }

  // ---------- the compiled workflow, read-only ----------
  function graphSvg(g) {
    if (!g || !g.nodes || !g.nodes.length) return '';
    const W = 180, H = 44;
    const by = {}; g.nodes.forEach((n) => { by[n.id] = n; });
    const maxX = Math.max.apply(null, g.nodes.map((n) => n.x)) + W + 20, maxY = Math.max.apply(null, g.nodes.map((n) => n.y)) + H + 20;
    const edges = g.edges.map((e) => { const a = by[e.from], b = by[e.to]; if (!a || !b) return ''; const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2; const mx = (x1 + x2) / 2; return '<path class="' + (e.branch === 'failure' ? 'f' : 'e') + '" d="M' + x1 + ' ' + y1 + ' C' + mx + ' ' + y1 + ' ' + mx + ' ' + y2 + ' ' + x2 + ' ' + y2 + '"/>' + (e.branch ? '<text class="bl" x="' + (mx - 10) + '" y="' + ((y1 + y2) / 2 - 3) + '">' + esc(e.branch) + '</text>' : ''); }).join('');
    const nodes = g.nodes.map((n) => { const t = n.title.length > 28 ? n.title.slice(0, 27) + '…' : n.title; return '<rect x="' + n.x + '" y="' + n.y + '" width="' + W + '" height="' + H + '" rx="6"/><text x="' + (n.x + 8) + '" y="' + (n.y + 17) + '">' + esc(n.kind) + '</text><text x="' + (n.x + 8) + '" y="' + (n.y + 33) + '">' + esc(t) + '</text>'; }).join('');
    return '<svg class="lcf-graph" viewBox="0 0 ' + maxX + ' ' + maxY + '" width="' + maxX + '" role="img" aria-label="The compiled workflow: ' + g.nodes.length + ' steps, ' + g.edges.length + ' edges">' + edges + nodes + '</svg>';
  }

  // ---------- the integration actions' fields ----------
  // An approval with no run condition before action i: a write tool or script after it is allowed.
  const approvedBefore = (fd, i) => fd.actions.slice(0, i).some((b) => b.type === 'approval' && !b.when && b.onError !== 'continue');
  function integrationFields(a, i, fd, pal, st) {
    const tools = pal.tools || [];
    const approvalNote = (what) => (approvedBefore(fd, i) ? '' : UI.notice(esc(what) + ' writes: add an "Ask for an approval" action with no run condition before this one, or the flow is not saved.', 'warn'));
    if (a.type === 'tool') {
      const t = tools.find((x) => x.name === a.tool);
      return UI.field('Find a tool', UI.input(st.ftoolq || '', { placeholder: 'Name or description', attrs: 'data-ftoolq aria-controls="lcf-toolsel"' }), '<span data-ftoolcount aria-live="polite">' + esc(toolCount(tools, st.ftoolq)) + '</span>')
        + UI.field('Tool', '<select class="select" id="lcf-toolsel" data-fa="tool">' + toolOptions(tools, a.tool || '', st.ftoolq) + '</select>', tools.length ? 'Grouped by source: built-in, registry, MCP servers and promoted scripts published to this workspace. Calls go through the dispatcher and the tool-call guardrail.' : 'No tools are published to this workspace yet.')
        + (t ? UI.kv([['Side effect', UI.pill(t.sideEffect, t.sideEffect === 'read' ? 'outline' : t.sideEffect === 'write' ? 'warn' : 'danger')], ['Max label', UI.label(t.label, { sm: true })], ['Version', esc(t.version)]], 3) + (t.description ? '<div class="muted" style="font-size:12px">' + esc(t.description) + '</div>' : '') + (t.needsApproval ? approvalNote(t.name) : '') + (t.fits ? '' : UI.notice(esc(t.name) + ' takes data up to ' + esc(t.label) + '; this flow carries ' + esc(pal.label) + ' data.', 'danger')) : '')
        + UI.field('Arguments', UI.textarea(lines(a.args), { rows: 3, attrs: 'data-fa="args"', placeholder: 'expression: {{input.record.values.amount}} * 2' }), 'One per line: name: template.');
    }
    if (a.type === 'script') {
      const scs = pal.scripts || [];
      const sc = scs.find((x) => x.name === a.script);
      const sopts = [{ value: '', label: scs.length ? 'choose a script' : 'no scripts can run here yet' }].concat(scs.map((x) => ({ value: x.name, label: x.name + ' · ' + x.language + ' · ' + x.label + (x.reviewed ? ' · reviewed v' + x.reviewed.version : x.versions.length ? ' · tested' : ' · not runnable yet') })));
      if (a.script && !sc) sopts.push({ value: a.script, label: a.script + ' (not available here)' });
      const rv = sc && sc.reviewed;
      const vopts = [{ value: '', label: rv ? 'reviewed version (v' + rv.version + ', tool ' + rv.tool + ')' : 'reviewed version (none yet)' }].concat(sc ? sc.versions.map((v) => ({ value: String(v.version), label: 'v' + v.version + (v.reviewed ? ' · reviewed' : ' · ran cleanly') })) : []);
      if (a.version && !vopts.some((o) => o.value === String(a.version))) vopts.push({ value: String(a.version), label: 'v' + a.version + ' (cannot run unattended)' });
      const writes = rv && (!a.version || a.version === rv.version) && (rv.sideEffect !== 'read' || rv.confirm === 'always');
      return (pal.canRunScripts === false ? UI.notice('A script action needs the scripts:run permission.', 'warn') : '')
        + UI.field('Script', UI.select(sopts, a.script || '', 'data-fa="script"'), 'Scripts in this workspace and tenant-wide ones, at or below your clearance.')
        + UI.field('Version', UI.select(vopts, a.version ? String(a.version) : '', 'data-fa="version"'), 'Only a reviewed version (the one its published tool pins) or one that passed its checks and ran cleanly runs unattended.')
        + (writes ? approvalNote(sc.name) : '')
        + UI.field('Arguments', UI.textarea(lines(a.args), { rows: 3, attrs: 'data-fa="args"', placeholder: 'amount: {{input.record.values.amount}}' }), 'One per line: name: template. Sent as JSON on stdin; the JSON it prints is this action\'s output.');
    }
    if (a.type === 'agent') {
      const ags = pal.agents || [];
      const opts = [{ value: '', label: ags.length ? 'choose an agent' : 'no agent is published here' }].concat(ags.map((x) => ({ value: x.name, label: x.name + ' ' + x.version + ' · ' + x.label + (x.fits ? '' : ' · below this label') })));
      if (a.agent && !ags.some((x) => x.name === a.agent)) opts.push({ value: a.agent, label: a.agent + ' (not published here)' });
      return UI.field('Agent', UI.select(opts, a.agent || '', 'data-fa="agent"'), 'Runs as the flow\'s owner, within its budgets, as a child of the run; the answer is {{steps.act' + (i + 1) + '.text}}.')
        + UI.field('Task', UI.textarea(a.input || '', { rows: 3, attrs: 'data-fa="input"', placeholder: 'Summarise the deal {{input.record.values.title}}' }));
    }
    if (a.type === 'ai') {
      const prs = pal.profiles || [];
      const opts = [{ value: '', label: prs.length ? 'choose a profile' : 'no profile is cleared for ' + (pal.label || 'this label') }].concat(prs.map((x) => ({ value: x.name, label: x.name + ' · up to ' + x.label })));
      if (a.profile && !prs.some((x) => x.name === a.profile)) opts.push({ value: a.profile, label: a.profile + ' (not cleared for ' + (pal.label || 'this label') + ')' });
      return UI.field('Profile', UI.select(opts, a.profile || '', 'data-fa="profile"'), 'Published profiles cleared for ' + esc(pal.label || 'the entity\'s label') + ', the label every run of this flow carries.')
        + UI.field('Prompt', UI.textarea(a.prompt || '', { rows: 4, attrs: 'data-fa="prompt"', placeholder: 'Write a one-line summary of {{input.record.values.title}}' }))
        + UI.field('Answer as', UI.select([{ value: 'text', label: 'text: {{steps.act' + (i + 1) + '.text}}' }, { value: 'json', label: 'a JSON object: its fields' }], a.format || 'text', 'data-fa="format"'));
    }
    if (a.type === 'message') {
      const to = a.conversation != null && a.conversation !== '' ? 'conversation' : a.user != null ? 'user' : 'conversation';
      return (pal.messaging ? '' : UI.notice('Messages need the built-in messages.send tool published to this workspace.', 'warn'))
        + approvalNote('Sending a message')
        + UI.field('To', UI.select([{ value: 'user', label: 'a person (direct message)' }, { value: 'conversation', label: 'a conversation (a group)' }], to, 'data-fa="msgto"'))
        + UI.field(to === 'user' ? 'Person (user id or template)' : 'Conversation (id or template)', UI.input((to === 'user' ? a.user : a.conversation) || '', { attrs: 'data-fa="' + to + '"', placeholder: to === 'user' ? '{{input.record.values.owner}}' : 'conversation id' }))
        + UI.field('Message', UI.textarea(a.body || '', { rows: 3, attrs: 'data-fa="body"', placeholder: 'Deal {{input.record.values.title}} is in.' }), 'Sent as the flow\'s owner; the content rules screen it.');
    }
    if (a.type === 'http') {
      return UI.notice('Only hosts on this tenant\'s list of allowed hosts (Registry, Allowed hosts). Credentials are vault references: a header such as Authorization: Bearer vault:apps/crm#token, a query parameter vault:path#key, or {vault:path#key} in the body. A literal secret is refused.', 'info')
        + UI.field('Method', UI.select(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], a.method || 'GET', 'data-fa="method"'))
        + UI.field('URL', UI.input(a.url || '', { attrs: 'data-fa="url"', placeholder: 'https://api.example.com/deals/{{input.record.id}}' }), 'The host is fixed; templates in the path and query are percent-encoded.')
        + UI.field('Headers', UI.textarea(lines(a.headers), { rows: 2, attrs: 'data-fa="headers"', placeholder: 'Authorization: Bearer vault:apps/crm#token' }), 'One per line: Content-Type, Accept, Authorization or X- headers.')
        + UI.field('Query parameters', UI.textarea(lines(a.query), { rows: 2, attrs: 'data-fa="query"', placeholder: 'key: vault:apps/crm#key' }), 'One per line: name: template or vault reference.')
        + (a.method && a.method !== 'GET' ? UI.field('Body', UI.textarea(a.body || '', { rows: 3, attrs: 'data-fa="body"', placeholder: '{"title": "{{input.record.values.title}}"}' })) : '')
        + '<div class="muted" style="font-size:12px">The answer is {{steps.act' + (i + 1) + '.status}} and {{steps.act' + (i + 1) + '.body}}; a status of 400 or more fails the action.</div>';
    }
    // Sprint 46 (B-131): a published decision table (Workflows, Decision tables), compiled onto a decision step.
    if (a.type === 'decision') {
      const ds = pal.decisions || [];
      const opts = [{ value: '', label: ds.length ? 'choose a table' : 'no decision table is published yet' }].concat(ds.map((x) => ({ value: x.name, label: x.name + ' · v' + x.version + ' · ' + x.label + (x.fits ? '' : ' (above this flow\'s label)') })));
      if (a.table && !ds.some((x) => x.name === a.table)) opts.push({ value: a.table, label: a.table + ' (not published here)' });
      return UI.field('Decision table', UI.select(opts, a.table || '', 'data-fa="table"'), 'Evaluated as the flow\'s owner; no code runs. Its outputs are {{steps.act' + (i + 1) + '.&lt;output&gt;}}, and the rules that matched {{steps.act' + (i + 1) + '.matched}}.')
        + UI.field('Version', UI.input(a.version || '', { type: 'number', attrs: 'data-fa="version"', placeholder: 'latest' }), 'Empty: the latest published version when the flow runs.')
        + UI.field('Inputs', UI.textarea(lines(a.inputs), { rows: 3, attrs: 'data-fa="inputs"', placeholder: 'amount: {{input.record.values.amount}}' }), 'One per line: input column: template. Empty: the record\'s fields of the same names.')
        + UI.field('When no rule matches', UI.select([{ value: 'continue', label: 'go on (outputs empty, or the table\'s defaults)' }, { value: 'fail', label: 'fail the action' }], a.noMatch || 'continue', 'data-fa="noMatch"'));
    }
    return '';
  }

  // The incoming webhook of a webhook flow: its address, on or off, and its secret.
  function hookPanel(fd) {
    if (!fd.id) return UI.notice('Save the flow to get its webhook address and secret. The hook stays off until you turn it on.', 'info');
    const hk = fd.hook || {};
    return '<div class="eyebrow">Incoming webhook</div>'
      + UI.field('Address', UI.input(hk.url || '', { readonly: true, attrs: 'data-fhookurl' }), 'POST JSON here, at most ' + Math.round((hk.maxBytes || 65536) / 1024) + ' KB, ' + esc(String(hk.ratePerMinute || 60)) + ' requests a minute.')
      + UI.kv([['State', UI.pill(hk.enabled ? 'on' : 'off', hk.enabled ? 'ok' : 'outline')], ['Secret', hk.secretSet ? 'set ' + esc(hk.secretSetAt ? new Date(hk.secretSetAt).toISOString().slice(0, 16).replace('T', ' ') : '') : 'none yet']], 2)
      + '<div class="muted" style="font-size:12px">Sign each request: <span class="mono">X-Exprsn-Timestamp</span> (Unix seconds, within 5 minutes) and <span class="mono">X-Exprsn-Signature: sha256=&lt;hex&gt;</span>, the HMAC-SHA256 of <span class="mono">&lt;timestamp&gt;.&lt;body&gt;</span> with the secret. A request is accepted once. The payload passes the content rules before any step reads it as {{input.payload.&lt;field&gt;}}; runs start as the person who turned the hook on.</div>'
      + '<div class="hstack wrap gap6">' + UI.btn(hk.secretSet ? 'Rotate secret' : 'Make secret', { size: 'sm', icon: 'key', attrs: 'data-fhookrot', disabled: !App.can('workflows:manage') }) + UI.btn(hk.enabled ? 'Turn the hook off' : 'Turn the hook on', { size: 'sm', kind: hk.enabled ? 'ghost' : 'primary', attrs: 'data-fhooken="' + (hk.enabled ? '0' : '1') + '"', disabled: !App.can('workflows:manage') || (!hk.enabled && !hk.secretSet) }) + '</div>';
  }

  // ---------- Sprint 47 (B-137): undo and redo, and actions copied between flows ----------
  // The flow being edited keeps a history of its model (trigger, condition, actions) for this session, at most 100
  // steps back. Actions are copied to this browser's clipboard (localStorage), so they paste into another flow, also
  // of another app; a pasted action's entity and fields are checked against this app at once, the rest when saving.
  const FCLIP = 'exprsn.appflows.clipboard';
  const modelOf = (fd) => JSON.stringify({ title: fd.title, entity: fd.entity, trigger: fd.trigger, enabled: fd.enabled, match: fd.match, actions: fd.actions, name: fd.id ? null : fd.name });
  const pastedFrom = typeof WeakMap === 'function' ? new WeakMap() : null;
  function fTrack(st) {
    const fd = st.fd;
    if (!fd) { st.fhist = null; return; }
    if (!st.fhist || st.fhist.ref !== fd) st.fhist = { ref: fd, cur: modelOf(fd), past: [], future: [] };
  }
  function fCommit(st) {
    fTrack(st); const h = st.fhist; if (!h) return;
    const j = modelOf(st.fd); if (j === h.cur) return;
    h.past.push(h.cur); if (h.past.length > 100) h.past.shift();
    h.cur = j; h.future = [];
  }
  function fStep(st, from, to) {
    fCommit(st); const h = st.fhist; if (!h || !h[from].length) return false;
    h[to].push(h.cur); h.cur = h[from].pop();
    const m = JSON.parse(h.cur);
    Object.assign(st.fd, { title: m.title, entity: m.entity, trigger: m.trigger, enabled: m.enabled, match: m.match, actions: m.actions, dirty: true });
    if (!st.fd.id && m.name != null) st.fd.name = m.name;
    if (/^a\d+$/.test(st.fnode || '') && +st.fnode.slice(1) >= st.fd.actions.length) st.fnode = 'trigger';
    return true;
  }
  function fClip() { try { const c = JSON.parse(localStorage.getItem(FCLIP) || 'null'); return c && Array.isArray(c.actions) && c.actions.length ? c : null; } catch (e) { return null; } }
  function fCopy(st, app, i) {
    const a = st.fd && st.fd.actions[i]; if (!a) return false;
    const c = { v: 1, at: Date.now(), from: { app: app.name, flow: st.fd.name || 'a new flow', entity: st.fd.entity }, actions: [clone(a)] };
    try { localStorage.setItem(FCLIP, JSON.stringify(c)); } catch (e) { /* storage unavailable */ }
    st.fclipMemory = c;
    return true;
  }
  function fPaste(st, at, c) {
    const fd = st.fd; c = c || fClip() || st.fclipMemory; if (!fd || !c) return -1;
    const room = 12 - fd.actions.length; if (room <= 0) return -2;
    const add = c.actions.slice(0, room).map(clone);
    fd.actions.splice(at, 0, ...add);
    add.forEach((a) => { if (pastedFrom) pastedFrom.set(a, c.from || {}); });
    return at;
  }
  /** What a pasted action names that this app does not have (its entity, the fields it writes). */
  function unresolved(a, app, fd) {
    const out = [];
    const target = a.entity || fd.entity;
    const ent = app.entities.find((e) => e.name === target);
    if (!ent) out.push('entity ' + target);
    else {
      const names = ((ent.definition && ent.definition.fields) || []).map((f) => f.name);
      Object.keys(a.values || {}).forEach((k) => { if (names.indexOf(k) < 0) out.push('field ' + target + '.' + k); });
      if (a.type === 'transition' && a.to) { const sm = ent.definition && ent.definition.states; if (!sm || !sm.states.some((x) => x.name === a.to)) out.push('state ' + a.to); }
    }
    return out;
  }

  App.appsFlows = function (ctx, app, deps) {
    const st = ctx.state;
    const A = '/api/apps/' + enc(app.id) + '/flows';
    // ----- data -----
    if (!st.flowList || st.flowList.app !== app.id) st.flowList = { app: app.id };
    const fl = st.flowList;
    if (!fl.list && !fl.busy && !fl.error) {
      fl.busy = true;
      App.get(A).then((d) => { fl.list = d.flows; fl.error = null; }).catch((err) => { fl.error = err; }).finally(() => { fl.busy = false; deps.refresh(); });
    }
    const reloadList = () => { st.flowList = { app: app.id }; };
    const list = fl.list || [];
    if (st.fd && st.fd.app !== app.id) st.fd = null;
    if (!st.fd && st.flowSel && st.flowSel !== 'new') {
      const id = st.flowSel;
      if (st.fdBusy !== id) {
        st.fdBusy = id;
        App.get(A + '/' + enc(id)).then((f) => { st.fd = Object.assign(fromView(f), { app: app.id }); st.fnode = 'trigger'; st.fproblems = null; }).catch((err) => { st.flowSel = null; App.fail(err, 'Could not open the flow'); }).finally(() => { st.fdBusy = null; deps.refresh(); });
      }
    }
    const fd = st.fd;
    if (fd && fd.id && (!st.fruns || st.fruns.id !== fd.id) && !st.frunsBusy) {
      st.frunsBusy = true; const fid = fd.id;
      App.get(A + '/' + enc(fid) + '/runs').then((d) => { st.fruns = { id: fid, list: d.runs }; }).catch(() => { st.fruns = { id: fid, list: [], error: true }; }).finally(() => { st.frunsBusy = false; deps.refresh(); });
    }
    const ent = fd ? app.entities.find((e) => e.name === fd.entity) || null : null;
    const canManage = App.can('workflows:manage');
    // What the integration actions may use here (tools, scripts, agents, profiles cleared for the entity's label).
    const palKey = fd ? app.id + '|' + fd.entity : null;
    if (fd && canManage && (!st.fpal || st.fpal.key !== palKey) && st.fpalBusy !== palKey) {
      st.fpalBusy = palKey;
      App.get(A + '/palette?entity=' + enc(fd.entity)).then((d) => { st.fpal = { key: palKey, data: d }; }).catch(() => { st.fpal = { key: palKey, data: null, error: true }; }).finally(() => { st.fpalBusy = null; deps.refresh(); });
    }
    const pal = (st.fpal && st.fpal.key === palKey && st.fpal.data) || { tools: [], scripts: [], agents: [], profiles: [], messaging: false, label: ent ? ent.label : '' };
    if (fd) fd.pal = pal;
    // Sprint 47 (B-137, B-140): the flow's undo history, and who else has it open (design-presence.js).
    fTrack(st);
    const dp = fd && fd.id && App.designPresence ? App.designPresence.use('app-flow', { kind: 'app-flow', app: app.id, id: fd.id, title: fd.title || fd.name }, { unsaved: () => !!(ctx.state.fd && ctx.state.fd.dirty), snapshot: () => { const f = ctx.state.fd; return f ? JSON.parse(modelOf(f)) : null; }, onRestore(m) { const f = ctx.state.fd; if (!f || !m) return; Object.assign(f, { title: m.title, entity: m.entity, trigger: m.trigger, enabled: m.enabled, match: m.match, actions: m.actions, dirty: true }); fCommit(ctx.state); ctx.rerender(); } }) : null;
    if (!dp && App.designPresence) App.designPresence.leave('app-flow');
    const lockedOut = !!(dp && App.designPresence.readOnly(dp));

    // ----- the list -----
    const trigText = (t) => (t.kind === 'record' ? 'on ' + t.events.join(', ') : t.kind === 'schedule' ? 'cron ' + t.cron + ' UTC' : t.kind === 'webhook' ? 'signed webhook' : 'by hand');
    const rows = list.map((f) => ({ cells: ['<span class="mono">' + esc(f.name) + '</span>' + (f.title ? '<div class="muted" style="font-size:12px">' + esc(f.title) + '</div>' : ''), esc(f.entity), esc(trigText(f.trigger)), '<span class="num">' + f.steps + '</span>', f.trigger.kind === 'manual' ? '<span class="muted">no trigger</span>' : f.trigger.kind === 'webhook' && !(f.hook && f.hook.enabled) ? '<span class="muted">hook off</span>' : UI.toggle(f.enabled ? 'on' : 'off', f.enabled, 'data-manual data-flowtoggle="' + esc(f.id) + '" aria-label="Flow ' + esc(f.name) + ' enabled"' + (canManage ? '' : ' disabled')), f.workflow ? '<a href="#" data-goworkflow="' + esc(f.workflowId) + '" class="mono">' + esc(f.workflow.name) + '</a> <span class="muted">v' + esc(String(f.workflow.publishedVersion || '')) + '</span>' + (f.editedElsewhere ? ' ' + UI.pill('edited on Workflows', 'warn') : '') : '<span class="muted">out of reach</span>', f.lastResult ? (/^skip/.test(f.lastResult) ? '<span style="color:var(--warn-fg)">' + esc(f.lastResult) + '</span>' : UI.pill(f.lastResult, /fail|error/.test(f.lastResult) ? 'danger' : 'ok')) : '<span class="muted">never</span>'], attrs: 'data-flow="' + esc(f.id) + '" tabindex="0" aria-label="Flow ' + esc(f.name) + '"', selected: fd && fd.id === f.id }));
    let head = '<style>' + CSS + '</style>' + UI.notice('A flow is an automation of this app: a trigger, an optional condition and actions in order. Saving compiles it into a workflow (one branch step per comparison, one step per action), publishes it and keeps its trigger, which runs as you. Runs, approvals, retries and labels are the Workflows ones; records above the entity\'s label are skipped. Audited app.flow.*.', 'info');
    if (!canManage) head += UI.notice('Changing flows also needs workflows:manage (the workflow-admin role): a flow creates and publishes its workflow.', 'warn');
    if (fl.error) head += UI.problem('Flows could not be loaded', deps.detailOf(fl.error), deps.traceOf(fl.error)) + '<div>' + UI.btn('Try again', { attrs: 'data-flowsreload' }) + '</div>';
    const table = UI.panel('Flows', (fl.list ? UI.table(['Flow', 'Entity', 'Trigger', 'Actions', 'Enabled', 'Workflow', 'Last result'], rows, { minWidth: '820px', emptyTitle: 'No flows', emptyText: 'Create one with New flow, or describe it to a model.' }) : UI.notice('Loading…', 'info'))
      + '<div class="hstack wrap gap6">' + UI.btn('New flow', { kind: 'primary', size: 'sm', icon: 'plus', attrs: 'data-flownew', disabled: !canManage || !app.entities.length }) + UI.btn('Draft with a model', { size: 'sm', icon: 'brain', attrs: 'data-flowdraft', disabled: !canManage || !app.entities.length }) + '</div>');

    // ----- the canvas -----
    let canvas = '', inspector = '';
    if (st.flowSel && !fd) canvas = UI.notice('Opening the flow…', 'info');
    if (fd) {
      const sel = st.fnode || 'trigger';
      const node = (id, kind, badge, title, sub, extra) => '<button type="button" class="lcf-node k-' + kind + '" data-fnode="' + id + '" aria-pressed="' + (sel === id ? 'true' : 'false') + '"><div class="lcf-badge">' + esc(badge) + '</div><div class="lcf-title">' + esc(title) + '</div>' + (sub ? '<div class="lcf-sub">' + esc(sub) + '</div>' : '') + (extra || '') + '</button>';
      const arrow = '<div class="lcf-arrow" aria-hidden="true"></div>';
      const hostOf = (u) => { const m = /^[a-z]+:\/\/([^/:?#]+)/i.exec(u || ''); return m ? m[1] : '?'; };
      const actTitle = (a) => (a.type !== 'notify' && a.title) || (a.type === 'decision' ? 'Decide with ' + (a.table || '?') + (a.version ? ' v' + a.version : '') : a.type === 'update' ? 'Update ' + (a.entity || fd.entity) + ': ' + (Object.keys(a.values || {}).join(', ') || 'no field yet') : a.type === 'transition' ? 'Move ' + (a.entity || fd.entity) + ' to ' + (a.to || '?') : a.type === 'create' ? 'Create ' + (a.entity || '?') : a.type === 'notify' ? 'Notify ' + (a.roles || []).concat(a.users || []).join(', ') + (a.title ? ': ' + a.title : '') : a.type === 'approval' ? 'Approval by ' + a.role : a.type === 'wait' ? 'Wait ' + a.minutes + ' min'
        : a.type === 'tool' ? 'Run ' + (a.tool || 'a tool') : a.type === 'script' ? 'Run script ' + (a.script || '?') + (a.version ? ' v' + a.version : '') : a.type === 'agent' ? 'Ask ' + (a.agent || 'an agent') : a.type === 'ai' ? 'AI step with ' + (a.profile || '?') : a.type === 'message' ? (a.conversation ? 'Message a conversation' : 'Message a person') : a.type === 'http' ? (a.method || 'GET') + ' ' + hostOf(a.url) : a.type);
      const actSub = (a) => [a.when ? 'only when ' + condText(a.when) : null, a.onError === 'continue' ? 'goes on after a failure' : null, a.retries ? 'retries ' + a.retries : null].filter(Boolean).join(' · ');
      const nodes = [node('trigger', 'trigger', 'Trigger', fd.trigger.kind === 'record' ? 'When ' + (fd.entity || '?') + ' is ' + (fd.trigger.events.join(' or ') || '?') : fd.trigger.kind === 'schedule' ? 'On schedule ' + (fd.trigger.cron || '?') : fd.trigger.kind === 'webhook' ? 'On a signed webhook' : 'Started by hand', (fd.name || 'new flow') + (fd.enabled ? '' : ', disabled') + (fd.trigger.kind === 'webhook' ? (fd.hook && fd.hook.enabled ? ', hook on' : ', hook off') : '')), node('condition', 'condition', 'Condition', fd.match ? 'Only when ' + condText(fd.match) : 'Always', fd.match ? leafCount(fd.match) + ' comparison' + (leafCount(fd.match) === 1 ? '' : 's') : 'no filter')]
        .concat(fd.actions.map((a, i) => node('a' + i, 'action', (i + 1) + '. ' + typeLabel(a.type), actTitle(a), actSub(a))))
        .concat(['<div class="lcf-node k-end" aria-hidden="true"><div class="lcf-badge">End</div><div class="lcf-sub">The run ends; a failure without "go on" fails it.</div></div>']);
      const problems = st.fproblems && st.fproblems.key === fd.key ? UI.notice('<b>' + esc(st.fproblems.title) + '.</b><ul style="margin:4px 0 0 18px">' + st.fproblems.list.map((p) => '<li>' + esc(p) + '</li>').join('') + '</ul>', 'danger') : '';
      const runs = fd.id ? (st.fruns && st.fruns.id === fd.id ? UI.table(['Run', 'Mode', 'Trigger', 'State', 'Started'], st.fruns.list.map((r) => ['<a href="#" class="mono" data-gorun="' + esc(r.id) + '">' + esc(r.id.slice(-8)) + '</a>', esc(r.mode), esc(r.trigger || ''), UI.pill(r.state), esc(deps.when(r.createdAt))]), { clickable: false, minWidth: '0', emptyTitle: 'No runs yet', emptyText: 'Runs appear when the trigger fires or you test the flow.' }) : UI.notice('Loading the runs…', 'info')) : '<span class="muted" style="font-size:12px">Save the flow to see its runs.</span>';
      canvas = UI.panel('Flow canvas: ' + esc(fd.title || fd.name || 'new flow'),
        (dp ? App.designPresence.bar(dp) : '') + (fd.editedElsewhere ? UI.notice('<b>Edited on Workflows.</b> Its workflow changed on the Workflows screen since this flow last saved it. Saving here replaces that change after you confirm.', 'warn') : '') + problems
        + '<div class="lcf-canvas" role="group" aria-label="Flow steps">' + nodes.join(arrow) + '</div>'
        + '<div class="hstack wrap gap6">' + UI.field('Add an action', UI.select(TYPES, 'update', 'data-fnewtype'), '') + UI.btn('Add action', { size: 'sm', icon: 'plus', attrs: 'data-faddact', disabled: fd.actions.length >= 12 || lockedOut }) + UI.btn('Paste action', { size: 'sm', attrs: 'data-fpasteact', disabled: lockedOut || fd.actions.length >= 12 || !(fClip() || st.fclipMemory), title: 'Paste the copied action at the end (Ctrl+V on the canvas)' }) + UI.btn('Undo', { size: 'sm', kind: 'ghost', icon: 'undo', attrs: 'data-fundo', disabled: lockedOut || !(st.fhist && (st.fhist.past.length || modelOf(fd) !== st.fhist.cur)), title: 'Undo (Ctrl+Z on the canvas)' }) + UI.btn('Redo', { size: 'sm', kind: 'ghost', attrs: 'data-fredo', disabled: lockedOut || !(st.fhist && st.fhist.future.length), title: 'Redo (Shift+Ctrl+Z on the canvas)' }) + '</div>'
        + (fd.graph ? '<details><summary class="muted" style="cursor:pointer">The compiled workflow (' + fd.graph.nodes.length + ' steps)</summary><div class="tablewrap" style="padding:6px">' + graphSvg(fd.graph) + '</div></details>' : '')
        + '<div class="eyebrow">Runs</div>' + runs + (fd.id ? '<div>' + UI.btn('Refresh runs', { size: 'xs', kind: 'ghost', icon: 'refresh', attrs: 'data-fruns' }) + '</div>' : ''),
        { actions: (fd.dirty ? '<span class="muted" style="font-size:12px">Unsaved changes</span> ' : '') + UI.btn(fd.id ? 'Save and publish' : 'Create flow', { kind: 'primary', size: 'sm', attrs: 'data-fsave', disabled: !canManage || lockedOut }) + UI.btn(fd.id ? 'Discard changes' : 'Cancel', { size: 'sm', kind: 'ghost', attrs: 'data-fdiscard', disabled: fd.id && !fd.dirty }) + (fd.id ? UI.btn('Test on a record', { size: 'sm', icon: 'play', attrs: 'data-ftestrun', disabled: !canManage }) + UI.btn('Delete flow', { size: 'sm', kind: 'ghost', attrs: 'data-fdelflow', disabled: !canManage }) : '') });

      // ----- the inspector -----
      const fopts = fieldOptions(ent, fd.trigger.kind);
      const entOpts = app.entities.map((e) => ({ value: e.name, label: e.title || e.name }));
      let ins = '';
      if (sel === 'trigger') {
        ins = '<div class="eyebrow">Trigger</div>'
          + (fd.id ? UI.kv([['Name', '<span class="mono">' + esc(fd.name) + '</span>']], 1) : UI.field('Name', UI.input(fd.name, { attrs: 'data-fd="name"', placeholder: 'lower-case letters, digits and _' }), 'Unique in the app; the workflow is app-' + esc(app.name) + '-<name>.'))
          + UI.field('Title', UI.input(fd.title, { attrs: 'data-fd="title"' }))
          + UI.field('Entity', UI.select(entOpts, fd.entity, 'data-fd="entity"'), 'The records the flow watches; its actions write them by default.')
          + UI.field('Starts', UI.seg([{ id: 'record', label: 'On record events' }, { id: 'schedule', label: 'On a schedule' }, { id: 'webhook', label: 'On a webhook' }, { id: 'manual', label: 'By hand' }], fd.trigger.kind, 'data-ftk aria-label="How the flow starts"'))
          + (fd.trigger.kind === 'record' ? UI.field('Events', '<div class="hstack wrap gap6">' + EVENTS.map((e) => UI.check(e, fd.trigger.events.indexOf(e) >= 0, 'data-fev="' + e + '"')).join('') + '</div>') : '')
          + (fd.trigger.kind === 'schedule' ? UI.field('Cron', UI.input(fd.trigger.cron || '', { attrs: 'data-fd="cron"', placeholder: '0 9 * * 1' }), 'Five fields, UTC: minute, hour, day of month, month, day of week.') : '')
          + (fd.trigger.kind === 'manual' ? UI.notice('A flow started by hand has no trigger. Test it on a record here, or start its workflow from Workflows.', 'info') : '')
          + (fd.trigger.kind === 'webhook' ? hookPanel(fd) : '')
          + UI.check('Enabled: the trigger fires', fd.enabled, 'data-fd="enabled"');
      } else if (sel === 'condition') {
        ins = '<div class="eyebrow">Condition</div><p class="fg2" style="margin:0;font-size:12px">The actions run only when the record matches. Text compares as written; numbers as numbers.</p>'
          + builderHtml(fd.match, 'match', fopts, 'Always: no condition.') + (fd.match ? '<div>' + UI.btn('Clear the condition', { size: 'xs', kind: 'ghost', attrs: 'data-cclear="match"' }) + '</div>' : '');
      } else {
        const i = +sel.slice(1); const a = fd.actions[i];
        if (!a) { st.fnode = 'trigger'; } else {
          const target = app.entities.find((e) => e.name === (a.entity || fd.entity)) || null;
          const writable = ((target && target.definition && target.definition.fields) || []).filter((f) => f.type !== 'formula' && f.type !== 'ai').map((f) => ({ value: f.name, label: f.title ? f.title + ' (' + f.name + ')' : f.name }));
          const vals = Object.keys(a.values || {});
          const valueRows = (a.type === 'update' || a.type === 'create') ? '<div class="eyebrow">Values</div>' + vals.map((k, j) => '<div class="lcf-val">' + UI.field('Field', UI.select(writable.concat(writable.some((w) => w.value === k) ? [] : [{ value: k, label: k + ' (unknown)' }]), k, 'data-fvk="' + j + '"')) + UI.field('Value or template', UI.input(a.values[k], { attrs: 'data-fvv="' + j + '"', placeholder: '{{input.record.values.' + k + '}}' })) + UI.iconbtn('trash', 'Remove ' + k, { attrs: 'data-fvdel="' + j + '"', cls: 'sm ghost' }) + '</div>').join('') + '<div>' + UI.btn('Add a value', { size: 'xs', icon: 'plus', attrs: 'data-fvadd', disabled: vals.length >= writable.length }) + '</div><div class="muted" style="font-size:12px">Templates read the run input: {{input.record.id}}, {{input.record.values.&lt;field&gt;}}, {{input.event}}.</div>' : '';
          const sm = target && target.definition && target.definition.states;
          ins = '<div class="hstack"><div class="eyebrow grow">Action ' + (i + 1) + '</div>' + UI.iconbtn('chev', 'Move action ' + (i + 1) + ' up', { attrs: 'data-fmv="-1"' + (i === 0 ? ' disabled' : ''), cls: 'sm ghost' }) + UI.iconbtn('chevd', 'Move action ' + (i + 1) + ' down', { attrs: 'data-fmv="1"' + (i === fd.actions.length - 1 ? ' disabled' : ''), cls: 'sm ghost' }) + UI.iconbtn('copy', 'Copy action ' + (i + 1), { attrs: 'data-fcopyact', cls: 'sm ghost' }) + UI.btn('Duplicate', { size: 'xs', kind: 'ghost', attrs: 'data-fdupact', disabled: fd.actions.length >= 12 }) + UI.iconbtn('trash', 'Remove action ' + (i + 1), { attrs: 'data-fdelact', cls: 'sm ghost' }) + '</div>'
            + (pastedFrom && pastedFrom.get(a) ? (() => { const from = pastedFrom.get(a); const miss = unresolved(a, app, fd); return UI.notice('<b>Pasted from ' + esc(from.flow || 'a flow') + (from.app && from.app !== app.name ? ' in ' + esc(from.app) : '') + '.</b> ' + (miss.length ? 'Not in this app: ' + esc(miss.join(', ')) + '. Change them before saving.' : 'Its entity and fields are in this app; the rest is checked when you save.'), miss.length ? 'warn' : 'info'); })() : '')
            + UI.field('Type', UI.select(TYPES, a.type, 'data-fa="type"'))
            + (a.type === 'notify' ? '' : UI.field('Step title (optional)', UI.input(a.title || '', { attrs: 'data-fa="title"', placeholder: actTitle(Object.assign({}, a, { title: '' })) })))
            + (a.type === 'create' ? UI.field('Entity', UI.select(entOpts, a.entity, 'data-fa="entity"')) : '')
            + (a.type === 'update' || a.type === 'transition' ? UI.field('Entity', UI.select([{ value: '', label: 'the flow\'s entity (' + fd.entity + ')' }].concat(entOpts), a.entity || '', 'data-fa="entity"')) + UI.field('Record', UI.input(a.record || '', { attrs: 'data-fa="record"', placeholder: '{{input.record.id}}' }), 'Empty: the record that started the flow.') : '')
            + (a.type === 'transition' ? UI.field('To state', sm ? UI.select(sm.states.map((s) => ({ value: s.name, label: s.title || s.name })), a.to, 'data-fa="to"') : UI.input(a.to || '', { attrs: 'data-fa="to"' }), sm ? 'A move the record\'s state does not allow fails the step (409).' : 'This entity has no state machine.') : '')
            + valueRows
            + (a.type === 'notify' ? UI.field('Roles, comma-separated', UI.input((a.roles || []).join(', '), { attrs: 'data-fa="roles"' })) + UI.field('Users, comma-separated', UI.input((a.users || []).join(', '), { attrs: 'data-fa="users"', placeholder: 'user ids or templates' })) + UI.field('Notice title', UI.input(a.title || '', { attrs: 'data-fa="title"', placeholder: 'Deal {{input.record.values.title}} needs a look' })) : '')
            + (a.type === 'notify' ? UI.field('Body', UI.textarea(a.body || '', { rows: 2, attrs: 'data-fa="body"' })) : '')
            + (a.type === 'approval' ? UI.field('Approver role', UI.input(a.role || '', { attrs: 'data-fa="role"' })) + UI.field('Shown to the approver', UI.textarea(a.show || '', { rows: 2, attrs: 'data-fa="show"', placeholder: 'Deal {{input.record.values.title}}' })) + UI.field('Decide within (hours)', UI.input(a.timeoutHours, { type: 'number', attrs: 'data-fa="timeoutHours" min="1" max="168"' })) : '')
            + (a.type === 'wait' ? UI.field('Minutes', UI.input(a.minutes, { type: 'number', attrs: 'data-fa="minutes" min="1" max="10080"' })) : '')
            + integrationFields(a, i, fd, pal, st)
            + (i > 0 ? '<div class="muted" style="font-size:12px">Earlier actions\' outputs: ' + fd.actions.slice(0, i).map((b, k) => '<span class="mono">' + esc('{{steps.act' + (k + 1) + '.' + ((OUTPUTS[b.type] || [])[0] || '<field>') + '}}') + '</span> (' + esc(typeLabel(b.type).toLowerCase()) + ((OUTPUTS[b.type] || []).length > 1 ? '; also ' + esc(OUTPUTS[b.type].slice(1).join(', ')) : '') + ')').join(', ') + '.</div>' : '')
            + '<div class="divider"></div><div class="eyebrow">Run condition</div>' + builderHtml(a.when || null, 'when:' + i, fopts, 'Always runs.') + (a.when ? '<div>' + UI.btn('Clear the run condition', { size: 'xs', kind: 'ghost', attrs: 'data-cclear="when:' + i + '"' }) + '</div>' : '')
            + (a.type === 'approval' || a.type === 'wait' ? '' : '<div class="divider"></div><div class="formgrid">' + UI.field('On failure', UI.select([{ value: 'stop', label: 'stop the run' }, { value: 'continue', label: 'go on with the next action' }], a.onError || 'stop', 'data-fa="onError"')) + UI.field('Retries', UI.input(a.retries || 0, { type: 'number', attrs: 'data-fa="retries" min="0" max="3"' })) + '</div>');
        }
      }
      // Sprint 47 (B-140): someone else edits it: the step's fields are read-only here.
      inspector = '<aside class="inspector w360" aria-label="Flow step">' + (lockedOut ? '<fieldset disabled style="border:0;margin:0;padding:0;min-width:0;display:flex;flex-direction:column;gap:12px"><legend class="sr">Read-only while someone else edits</legend>' + ins + '</fieldset>' : ins) + '</aside>';
    } else {
      inspector = '<aside class="inspector w300" aria-label="Flow step">' + UI.empty('No flow open', 'Pick a flow, or create one, to edit its trigger, condition and actions here.') + '</aside>';
    }

    // ----- events -----
    const touch = () => { if (st.fd) { st.fd.dirty = true; fCommit(st); if (dp) App.designPresence.claim(dp); } };
    // Re-render and put the focus back on the control that had it (by its data attribute).
    const keepFocus = () => {
      const a = document.activeElement; let sel = null;
      if (a && a.attributes) for (let i = 0; i < a.attributes.length; i++) { const n = a.attributes[i].name; if (/^data-(f|c)/.test(n)) { sel = '[' + n + '="' + (a.getAttribute(n) || '').replace(/"/g, '\\"') + '"]'; break; } }
      ctx.rerender();
      const el = sel ? ctx.$(sel) : null; if (el) el.focus();
    };
    const rerenderSoon = () => setTimeout(() => { if (App.state.route === 'apps') keepFocus(); }, 0);
    const openFlow = async (id) => {
      if (st.fd && st.fd.dirty && st.fd.key !== id) { const ok = await ctx.confirm({ title: 'Discard the unsaved changes', tone: 'warn', body: '<p class="fg2" style="margin:0">The flow you are editing has changes that are not saved.</p>', ok: 'Discard' }); if (!ok) return; }
      st.flowSel = id; st.fd = null; st.fnode = 'trigger'; st.fproblems = null; st.fruns = null;
      if (id === 'new') { st.fd = Object.assign(emptyFlow(app), { app: app.id }); }
      ctx.rerender();
    };
    ctx.on('click', '[data-flowsreload]', () => { reloadList(); ctx.rerender(); });
    ctx.on('click', 'tr[data-flow]', (e, t) => { if (e.target.closest('a') || e.target.closest('[data-flowtoggle]')) return; openFlow(t.dataset.flow); });
    ctx.on('keydown', 'tr[data-flow]', (e, t) => { if (e.target !== t || (e.key !== 'Enter' && e.key !== ' ')) return; e.preventDefault(); openFlow(t.dataset.flow); });
    ctx.on('click', '[data-flownew]', () => openFlow('new'));
    ctx.on('click', '[data-flowtoggle]', async (e, t) => {
      const f = list.find((x) => x.id === t.dataset.flowtoggle); if (!f) return;
      try { await App.patch(A + '/' + enc(f.id), { enabled: !f.enabled }); reloadList(); if (st.fd && st.fd.id === f.id) st.fd.enabled = !f.enabled; ctx.rerender(); ctx.toast('Flow ' + esc(f.name) + (f.enabled ? ' disabled' : ' enabled') + '. Audited app.flow.updated and app.trigger.updated.', 'ok'); } catch (err) { App.fail(err, 'Could not change the flow'); }
    });
    ctx.on('click', '[data-flowdraft]', () => openDraft(ctx, app, deps));
    if (!fd) return { body: head + table + canvas, inspector };

    ctx.on('click', '[data-fnode]', (e, t) => { st.fnode = t.dataset.fnode; ctx.rerender(); const el = ctx.$('[data-fnode="' + t.dataset.fnode + '"]'); if (el) el.focus(); });
    ctx.on('click', '[data-fruns]', () => { st.fruns = null; ctx.rerender(); });
    // The tool picker's search: refills the grouped list in place, so the search box keeps focus.
    ctx.on('input', '[data-ftoolq]', (e, t) => {
      st.ftoolq = t.value; const a = st.fnode && st.fnode[0] === 'a' ? fd.actions[+st.fnode.slice(1)] : null;
      const sel = ctx.$('#lcf-toolsel'); const count = ctx.$('[data-ftoolcount]');
      if (sel) sel.innerHTML = toolOptions(pal.tools || [], (a && a.tool) || '', st.ftoolq);
      if (count) count.textContent = toolCount(pal.tools || [], st.ftoolq);
    });
    ctx.on('click', '[data-fhookrot]', async () => {
      const hk = fd.hook || {};
      if (hk.secretSet) { const ok = await ctx.confirm({ title: 'Rotate the webhook secret', tag: 'old secret stops', tone: 'warn', body: '<p class="fg2" style="margin:0">A new secret replaces the old one at once: requests signed with the old secret are refused from now on. The new one is shown once.</p>', ok: 'Rotate' }); if (!ok) return; }
      try {
        const out = await App.post(A + '/' + enc(fd.id) + '/hook/secret', {});
        fd.hook = Object.assign({}, fd.hook || {}, { secretSet: true, secretSetAt: out.secretSetAt, url: out.url, path: out.path }); st.flowList = { app: app.id };
        ctx.rerender();
        deps.modal({ title: 'Webhook secret', body: UI.notice('Copy it now: it is shown once and stored sealed. Rotate it to replace it. Audited app.flow.hook.rotated.', 'warn') + UI.field('Secret', UI.input(out.secret, { readonly: true, attrs: 'data-fhooksecret' })) + UI.field('Address', UI.input(out.url, { readonly: true })), actions: UI.btn('Done', { kind: 'primary', attrs: 'data-close' }), onMount(m) { const el = m.querySelector('[data-fhooksecret]'); if (el) { el.focus(); el.select(); } } });
      } catch (err) { App.fail(err, 'The secret was not made'); }
    });
    ctx.on('click', '[data-fhooken]', async (e, t) => {
      const on = t.dataset.fhooken === '1';
      if (on) { const ok = await ctx.confirm({ title: 'Turn the webhook on', tag: 'public address', tone: 'warn', body: '<p class="fg2" style="margin:0">Signed requests to the address start this flow, as you, at the entity\'s label. Unsigned, stale and repeated requests are refused and audited.</p>', ok: 'Turn on' }); if (!ok) return; }
      try { const h = await App.put(A + '/' + enc(fd.id) + '/hook', { enabled: on }); fd.hook = h; st.flowList = { app: app.id }; ctx.rerender(); ctx.toast('Webhook ' + (on ? 'on' : 'off') + '. Audited app.flow.hook.updated.', on ? 'ok' : 'warn'); } catch (err) { App.fail(err, 'The webhook was not changed'); }
    });
    ctx.on('click', '[data-faddact]', () => { const type = (ctx.$('[data-fnewtype]') || {}).value || 'update'; fd.actions.push(newAction(type, app, fd)); st.fnode = 'a' + (fd.actions.length - 1); touch(); ctx.rerender(); });
    // Sprint 47 (B-137): undo, redo, copy, paste and duplicate of actions.
    const fUndo = (dir) => { if (lockedOut) return; if (fStep(st, dir < 0 ? 'past' : 'future', dir < 0 ? 'future' : 'past')) { if (dp) App.designPresence.claim(dp); ctx.rerender(); ctx.toast(dir < 0 ? 'Undone.' : 'Redone.'); } else ctx.toast(dir < 0 ? 'Nothing to undo.' : 'Nothing to redo.'); };
    const fPasteHere = (at) => { if (lockedOut) return; const r = fPaste(st, at); if (r === -1) { ctx.toast('Copy an action first.', 'warn'); return; } if (r === -2) { ctx.toast('A flow has at most 12 actions.', 'warn'); return; } st.fnode = 'a' + r; touch(); ctx.rerender(); ctx.toast('Action pasted. Its entity and fields are checked against this app.'); };
    ctx.on('click', '[data-fundo]', () => fUndo(-1));
    ctx.on('click', '[data-fredo]', () => fUndo(1));
    ctx.on('click', '[data-fcopyact]', () => { const i = +String(st.fnode).slice(1); if (fCopy(st, app, i)) { ctx.toast('Action ' + (i + 1) + ' copied. Paste it here or in another flow.'); ctx.rerender(); } });
    ctx.on('click', '[data-fpasteact]', () => fPasteHere(fd.actions.length));
    ctx.on('click', '[data-fdupact]', () => { if (lockedOut) return; const i = +String(st.fnode).slice(1); const a = fd.actions[i]; if (!a) return; const r = fPaste(st, i + 1, { actions: [a], from: { flow: fd.name || 'this flow', app: app.name } }); if (r < 0) { ctx.toast('A flow has at most 12 actions.', 'warn'); return; } if (pastedFrom) pastedFrom.delete(fd.actions[i + 1]); st.fnode = 'a' + (i + 1); touch(); ctx.rerender(); });
    ctx.on('keydown', '.lcf-canvas', (e) => {
      const mod = e.ctrlKey || e.metaKey; if (!mod || e.altKey) return;
      const k = (e.key || '').toLowerCase();
      if (k === 'z') { e.preventDefault(); fUndo(e.shiftKey ? 1 : -1); }
      else if (k === 'y' && !e.metaKey) { e.preventDefault(); fUndo(1); }
      else if (k === 'c' && /^a\d+$/.test(st.fnode || '') && !String(window.getSelection ? window.getSelection() : '')) { e.preventDefault(); const i = +st.fnode.slice(1); if (fCopy(st, app, i)) { ctx.toast('Action ' + (i + 1) + ' copied.'); ctx.rerender(); } }
      else if (k === 'v') { e.preventDefault(); fPasteHere(/^a\d+$/.test(st.fnode || '') ? +st.fnode.slice(1) + 1 : fd.actions.length); }
      else if (k === 'd' && /^a\d+$/.test(st.fnode || '')) { e.preventDefault(); const b = ctx.$('[data-fdupact]'); if (b && !b.disabled) b.click(); }
    });
    if (dp) App.designPresence.bind(ctx, dp);
    // trigger fields
    ctx.on('change', '[data-fd]', (e, t) => {
      const k = t.dataset.fd;
      if (k === 'enabled') fd.enabled = t.checked;
      else if (k === 'cron') fd.trigger.cron = t.value.trim();
      else if (k === 'entity') { fd.entity = t.value; }
      else fd[k] = t.value.trim();
      touch(); rerenderSoon();
    });
    ctx.on('click', '[data-ftk] [data-seg]', (e, t) => { const k = t.dataset.seg; fd.trigger = k === 'record' ? { kind: 'record', events: fd.trigger.events || ['created'] } : k === 'schedule' ? { kind: 'schedule', cron: fd.trigger.cron || '0 9 * * 1', events: fd.trigger.events } : { kind: k === 'webhook' ? 'webhook' : 'manual', events: fd.trigger.events, cron: fd.trigger.cron }; touch(); keepFocus(); });
    ctx.on('change', '[data-fev]', (e, t) => { const ev = fd.trigger.events = (fd.trigger.events || []).filter((x) => x !== t.dataset.fev); if (t.checked) ev.push(t.dataset.fev); fd.trigger.events = EVENTS.filter((x) => ev.indexOf(x) >= 0); touch(); rerenderSoon(); });
    // action fields
    const cur = () => (st.fnode && st.fnode[0] === 'a' ? fd.actions[+st.fnode.slice(1)] : null);
    ctx.on('change', '[data-fa]', (e, t) => {
      const a = cur(); if (!a) return; const k = t.dataset.fa; const i = +st.fnode.slice(1);
      if (k === 'type') { const n = newAction(t.value, app, fd); if (a.when) n.when = a.when; if (a.title && a.type !== 'notify' && n.type !== 'notify') n.title = a.title; fd.actions[i] = n; }
      else if (k === 'roles' || k === 'users') a[k] = t.value.split(',').map((s) => s.trim()).filter(Boolean);
      else if (k === 'args' || k === 'headers' || k === 'inputs') a[k] = unlines(t.value);
      else if (k === 'query') { const q = unlines(t.value); if (Object.keys(q).length) a.query = q; else delete a.query; }
      else if (k === 'version') { if (t.value) a.version = parseInt(t.value, 10); else delete a.version; }
      else if (k === 'script') { a.script = t.value; delete a.version; const sc = ((fd.pal || {}).scripts || []).find((x) => x.name === t.value); if (sc && !sc.reviewed && sc.versions.length) a.version = sc.versions[0].version; }
      else if (k === 'msgto') { const v = a.user || a.conversation || ''; delete a.user; delete a.conversation; a[t.value] = v; }
      else if (k === 'method') { a.method = t.value; if (t.value === 'GET') delete a.body; }
      else if (k === 'timeoutHours' || k === 'minutes' || k === 'retries') a[k] = Math.max(0, parseInt(t.value, 10) || 0);
      else if (k === 'entity' && a.type === 'transition') { a.entity = t.value; const tg = app.entities.find((x) => x.name === (t.value || fd.entity)); const sm = tg && tg.definition && tg.definition.states; a.to = sm ? sm.states[0].name : ''; }
      else a[k] = t.value;
      touch(); rerenderSoon();
    });
    ctx.on('click', '[data-fmv]', (e, t) => { const i = +st.fnode.slice(1); const j = i + +t.dataset.fmv; if (j < 0 || j >= fd.actions.length) return; const x = fd.actions.splice(i, 1)[0]; fd.actions.splice(j, 0, x); st.fnode = 'a' + j; touch(); ctx.rerender(); const el = ctx.$('[data-fmv="' + t.dataset.fmv + '"]'); if (el) el.focus(); });
    ctx.on('click', '[data-fdelact]', () => { const i = +st.fnode.slice(1); fd.actions.splice(i, 1); st.fnode = fd.actions.length ? 'a' + Math.min(i, fd.actions.length - 1) : 'condition'; touch(); ctx.rerender(); });
    const entriesOf = (a) => Object.keys(a.values || {}).map((k) => [k, a.values[k]]);
    ctx.on('change', '[data-fvk]', (e, t) => { const a = cur(); const en = entriesOf(a); en[+t.dataset.fvk][0] = t.value; a.values = {}; en.forEach((x) => { a.values[x[0]] = x[1]; }); touch(); rerenderSoon(); });
    ctx.on('change', '[data-fvv]', (e, t) => { const a = cur(); const en = entriesOf(a); en[+t.dataset.fvv][1] = t.value; a.values = {}; en.forEach((x) => { a.values[x[0]] = x[1]; }); touch(); rerenderSoon(); });
    ctx.on('click', '[data-fvdel]', (e, t) => { const a = cur(); const en = entriesOf(a); en.splice(+t.dataset.fvdel, 1); a.values = {}; en.forEach((x) => { a.values[x[0]] = x[1]; }); touch(); ctx.rerender(); });
    ctx.on('click', '[data-fvadd]', () => { const a = cur(); const target = app.entities.find((x) => x.name === (a.entity || fd.entity)); const free = ((target && target.definition.fields) || []).filter((f) => f.type !== 'formula' && f.type !== 'ai' && !(f.name in (a.values || {}))); if (!free.length) return; a.values = a.values || {}; a.values[free[0].name] = ''; touch(); ctx.rerender(); const el = ctx.$('[data-fvv="' + (Object.keys(a.values).length - 1) + '"]'); if (el) el.focus(); });
    // the condition builder
    const rootOf = (pfx) => (pfx === 'match' ? fd.match : (fd.actions[+pfx.split(':')[1]] || {}).when || null);
    const setRoot = (pfx, v) => { if (pfx === 'match') fd.match = v; else fd.actions[+pfx.split(':')[1]].when = v; };
    const parse = (key) => { const i = key.indexOf('|'); return { pfx: key.slice(0, i), path: key.slice(i + 1) === '' ? [] : key.slice(i + 1).split('.').map(Number) }; };
    const at = (root, path) => path.reduce((n, i) => (n ? kids(n)[i] : null), root);
    const firstField = () => { const o = fieldOptions(ent, fd.trigger.kind)[0]; return o ? o.value : 'event'; };
    const newLeaf = () => ({ field: firstField(), op: 'eq', value: '' });
    const typed = (field, s) => { const f = ent && ent.definition.fields.find((x) => x.name === field); if (f && f.type === 'number' && s !== '' && !isNaN(Number(s))) return Number(s); if (f && f.type === 'boolean') return s === 'true'; return s; };
    ctx.on('click', '[data-cadd],[data-caddg]', (e, t) => {
      const group = !!t.dataset.caddg; const p = parse(t.dataset.cadd || t.dataset.caddg); const root = rootOf(p.pfx);
      const item = group ? { all: [newLeaf()] } : newLeaf();
      if (!root) setRoot(p.pfx, item);
      else if (!p.path.length && !isGroup(root)) setRoot(p.pfx, { all: [root, item] });
      else kids(at(root, p.path)).push(item);
      touch(); keepFocus();
    });
    ctx.on('click', '[data-cdel]', (e, t) => { const p = parse(t.dataset.cdel); const root = rootOf(p.pfx); if (!p.path.length) setRoot(p.pfx, null); else { const parent = at(root, p.path.slice(0, -1)); kids(parent).splice(p.path[p.path.length - 1], 1); if (!kids(parent).length && p.path.length === 1) setRoot(p.pfx, null); } touch(); ctx.rerender(); });
    ctx.on('click', '[data-cclear]', (e, t) => { setRoot(t.dataset.cclear, null); touch(); ctx.rerender(); });
    ctx.on('change', '[data-cg]', (e, t) => { const p = parse(t.dataset.cg); const g = at(rootOf(p.pfx), p.path); const list2 = kids(g); delete g.all; delete g.any; delete g.none; g[t.value] = list2; touch(); rerenderSoon(); });
    ctx.on('change', '[data-cf]', (e, t) => { const p = parse(t.dataset.cf); const l = at(rootOf(p.pfx), p.path); l.field = t.value; touch(); rerenderSoon(); });
    ctx.on('change', '[data-co]', (e, t) => { const p = parse(t.dataset.co); const l = at(rootOf(p.pfx), p.path); l.op = t.value; if (NO_VALUE.indexOf(l.op) >= 0) delete l.value; else if (LIST_VALUE.indexOf(l.op) >= 0) l.value = Array.isArray(l.value) ? l.value : l.value === undefined || l.value === '' ? [] : [l.value]; else if (Array.isArray(l.value)) l.value = l.value[0] === undefined ? '' : l.value[0]; else if (l.value === undefined) l.value = ''; touch(); rerenderSoon(); });
    ctx.on('change', '[data-cv]', (e, t) => { const p = parse(t.dataset.cv); const l = at(rootOf(p.pfx), p.path); l.value = LIST_VALUE.indexOf(l.op) >= 0 ? t.value.split(',').map((s) => s.trim()).filter(Boolean).map((s) => typed(l.field, s)) : typed(l.field, t.value.trim()); touch(); rerenderSoon(); });
    // save, discard, test, delete
    ctx.on('click', '[data-fdiscard]', () => { if (fd.id) { st.fd = null; } else { st.fd = null; st.flowSel = null; } st.fproblems = null; ctx.rerender(); });
    ctx.on('click', '[data-fsave]', () => saveFlow(ctx, app, deps, false));
    ctx.on('click', '[data-ftestrun]', () => openTest(ctx, app, deps));
    ctx.on('click', '[data-fdelflow]', async () => {
      const ok = await ctx.confirm({ title: 'Delete flow ' + fd.name, tag: 'deletes its workflow', tone: 'danger', body: '<p class="fg2" style="margin:0">Deletes the flow, its trigger and its workflow with the workflow\'s versions. Refused while a run of it is in progress or waiting. Records it wrote stay.</p>', kv: [['Workflow', esc(fd.workflow ? fd.workflow.name : '')], ['Actions', fd.actions.length]], ok: 'Delete flow' });
      if (!ok) return;
      try { await App.del(A + '/' + enc(fd.id)); st.fd = null; st.flowSel = null; reloadList(); deps.afterChange({}); ctx.toast('Flow deleted with its trigger and workflow. Audited app.flow.deleted and workflow.deleted.', 'warn'); } catch (err) { App.fail(err, 'The flow was not deleted'); }
    });
    return { body: head + table + canvas, inspector };
  };

  async function saveFlow(ctx, app, deps, force) {
    const st = ctx.state; const fd = st.fd; if (!fd) return;
    const A = '/api/apps/' + enc(app.id) + '/flows';
    if (!fd.id && !/^[a-z][a-z0-9_]{0,62}$/.test(fd.name || '')) { st.fproblems = { key: fd.key, title: 'Not saved', list: ['Name the flow on the Trigger step: lower-case letters, digits and _, starting with a letter.'] }; st.fnode = 'trigger'; ctx.rerender(); return; }
    const body = payload(fd, !fd.id);
    if (force) body.force = true;
    try {
      const out = fd.id ? await App.put(A + '/' + enc(fd.id), body) : await App.post(A, body);
      st.fd = Object.assign(fromView(out), { app: app.id }); st.flowSel = out.id; st.fproblems = null; st.fruns = null; st.flowList = { app: app.id };
      deps.afterChange({});
      ctx.toast('Flow ' + esc(out.name) + ' saved; workflow ' + esc(out.workflow ? out.workflow.name : '') + ' published as version ' + esc(String(out.workflow ? out.workflow.publishedVersion : '')) + '. Audited app.flow.' + (fd.id ? 'updated' : 'created') + '.', 'ok', 5000);
    } catch (err) {
      const p = err.problem || {};
      if (err.status === 409 && p.editedElsewhere) {
        const ok = await ctx.confirm({ title: 'Replace the change made on Workflows', tag: 'overwrites', tone: 'warn', body: '<p class="fg2" style="margin:0">' + esc(deps.detailOf(err)) + '</p>', ok: 'Overwrite' });
        if (ok) saveFlow(ctx, app, deps, true);
        return;
      }
      const list = Array.isArray(p.problems) ? p.problems : Array.isArray(p.errors) ? p.errors.map((x) => x.message) : [deps.detailOf(err)];
      st.fproblems = { key: fd.key, title: (p.title || 'Not saved') + (err.status ? ' (' + err.status + ')' : ''), list };
      ctx.rerender();
    }
  }

  async function openTest(ctx, app, deps) {
    const st = ctx.state; const fd = st.fd; if (!fd || !fd.id) return;
    const ent = app.entities.find((e) => e.name === fd.entity);
    const A = '/api/apps/' + enc(app.id) + '/flows/' + enc(fd.id);
    let recs = [];
    const hook = fd.trigger.kind === 'webhook';
    if (fd.trigger.kind !== 'schedule' && !hook) {
      try { recs = (await App.get('/api/apps/' + enc(app.id) + '/entities/' + enc(ent ? ent.id : fd.entity) + '/records?limit=50')).records; } catch (err) { App.fail(err, 'Could not list the records'); return; }
    }
    const first = ent && ((ent.definition.fields || []).find((f) => f.indexed && f.type === 'string') || (ent.definition.fields || []).find((f) => f.type === 'string'));
    const recLabel = (r) => (first && r.values[first.name] ? String(r.values[first.name]) + ' · ' : '') + r.id.slice(-8) + (r.state ? ' · ' + r.state : '');
    deps.modal({ title: 'Test ' + esc(fd.name) + (hook ? ' with a payload' : ' on a record'), body: UI.notice('A dry run of the saved flow\'s workflow draft, with the input its trigger would give it: comparisons are made, and steps that write records, send notices or messages, call tools, scripts, agents, models or other systems, wait or ask for approval are mocked. Nothing changes. Audited app.flow.tested.', 'info')
      + (hook ? UI.field('Payload (JSON object)', UI.textarea('{\n  "title": "Test"\n}', { rows: 5, attrs: 'data-ft-payload' }), 'What a signed request would carry, as {{input.payload}}. Not signed and not sent through the hook.') : fd.trigger.kind === 'schedule' ? UI.notice('A schedule flow runs without a record.', 'info') : recs.length ? UI.field('Record', UI.select(recs.map((r) => ({ value: r.id, label: recLabel(r) })), recs[0].id, 'data-ft-rec'), 'The 50 most recently updated records you can read.') + (fd.trigger.kind === 'record' ? UI.field('As the event', UI.select(fd.trigger.events, fd.trigger.events[0], 'data-ft-ev')) : '') : UI.notice('No record of ' + esc(fd.entity) + ' to test on yet.', 'warn')) + '<div data-ft-out aria-live="polite"></div>',
    actions: UI.btn('Close', { attrs: 'data-close' }) + UI.btn('Start the dry run', { kind: 'primary', attrs: 'data-ft-go', disabled: fd.trigger.kind !== 'schedule' && !hook && !recs.length }),
    onMount(m) {
      m.querySelector('[data-ft-go]').addEventListener('click', async () => {
        const out = m.querySelector('[data-ft-out]'); const r = m.querySelector('[data-ft-rec]'); const ev = m.querySelector('[data-ft-ev]');
        const body = {}; if (r) body.record = r.value; if (ev) body.event = ev.value;
        const pl = m.querySelector('[data-ft-payload]');
        if (pl) { try { body.payload = JSON.parse(pl.value || '{}'); } catch (e2) { out.innerHTML = UI.notice('The payload is not JSON.', 'warn'); return; } if (!body.payload || typeof body.payload !== 'object' || Array.isArray(body.payload)) { out.innerHTML = UI.notice('The payload is a JSON object.', 'warn'); return; } }
        try { const run = await App.post(A + '/test', body); st.fruns = null; out.innerHTML = UI.notice('<b>Dry run ' + esc(run.run.slice(-8)) + ' started.</b> Open it on Runs to follow each step and which branches it took.', 'ok', UI.btn('Open the run', { size: 'sm', attrs: 'data-close data-gorunm="' + esc(run.run) + '"' })); const b = out.querySelector('[data-gorunm]'); if (b) b.addEventListener('click', () => setTimeout(() => ctx.navigate('runs', { run: run.run }), 0)); }
        catch (err) { out.innerHTML = UI.notice('<b>' + esc(String(err.status || '')) + '</b> ' + esc(deps.detailOf(err)), 'danger'); }
      });
    } });
  }

  async function openDraft(ctx, app, deps) {
    const st = ctx.state;
    const profiles = await deps.profilesList();
    deps.modal({ title: 'Draft a flow with a model', cls: 'wide', body: UI.notice('A local model, through the gateway and the published profile you name, drafts a flow from your description and this app\'s entities. The draft is checked like a saved flow and never saved on its own: open it in the canvas, review each step and save. The description passes the user-input guardrail. Audited app.flow.drafted.', 'info')
      + UI.field('Profile', profiles.length ? UI.select(profiles, profiles[0], 'data-fdr-profile') : UI.input('', { attrs: 'data-fdr-profile', placeholder: 'published profile name' }))
      + UI.field('Describe the flow', UI.textarea('', { rows: 3, attrs: 'data-fdr-prompt', placeholder: 'When a deal over 10,000 is won, move it to review and tell the sales managers.' })) + '<div data-fdr-out aria-live="polite"></div>',
    actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Draft', { kind: 'primary', attrs: 'data-fdr-go' }) + UI.btn('Open in the canvas', { attrs: 'data-fdr-open', disabled: true }),
    onMount(m) {
      let draft = null; const out = m.querySelector('[data-fdr-out]'); const open = m.querySelector('[data-fdr-open]');
      m.querySelector('[data-fdr-go]').addEventListener('click', async () => {
        const profile = m.querySelector('[data-fdr-profile]').value.trim(); const prompt = m.querySelector('[data-fdr-prompt]').value.trim();
        if (!profile || prompt.length < 3) { out.innerHTML = UI.notice('Pick a profile and describe the flow.', 'warn'); return; }
        out.innerHTML = '<div class="muted" style="font-size:12px">Asking ' + esc(profile) + '…</div>'; open.disabled = true;
        try {
          const r = await App.post('/api/apps/' + enc(app.id) + '/flows/draft', { prompt, profile });
          draft = r.draft && typeof r.draft === 'object' && Array.isArray(r.draft.actions) ? r.draft : null;
          out.innerHTML = (r.valid ? UI.notice('<b>The draft is valid.</b> ' + esc((draft.actions || []).length + ' action' + ((draft.actions || []).length === 1 ? '' : 's')) + ', trigger ' + esc(draft.trigger ? draft.trigger.kind : '') + '.', 'ok') : UI.notice('<b>The draft has problems.</b><ul style="margin:4px 0 0 18px">' + r.problems.map((p) => '<li>' + esc(p) + '</li>').join('') + '</ul>' + (draft ? 'Open it and fix them in the canvas.' : 'Draft again with more detail.'), 'warn'))
            + '<details style="margin-top:8px"><summary class="muted" style="cursor:pointer">Draft JSON</summary>' + UI.code(JSON.stringify(r.draft, null, 2), 'json') + '</details>';
          open.disabled = !draft;
        } catch (err) { draft = null; out.innerHTML = UI.notice('<b>' + esc(String(err.status || '')) + '</b> ' + esc(deps.detailOf(err)), 'danger'); }
      });
      open.addEventListener('click', () => {
        if (!draft) return;
        const base = emptyFlow(app);
        const fd = Object.assign(base, { name: typeof draft.name === 'string' ? draft.name : '', title: typeof draft.title === 'string' ? draft.title : '', entity: app.entities.some((e) => e.name === draft.entity) ? draft.entity : base.entity, trigger: draft.trigger && draft.trigger.kind ? Object.assign({ events: ['created'] }, draft.trigger) : base.trigger, match: draft.match || null, actions: draft.actions.map((a) => Object.assign({}, a)), app: app.id, dirty: true });
        if (fd.trigger.kind === 'record' && !Array.isArray(fd.trigger.events)) fd.trigger.events = ['created'];
        st.fd = fd; st.flowSel = 'new'; st.fnode = 'trigger'; st.fproblems = null; st.fruns = null;
        App.closeOverlay(); ctx.rerender(); ctx.toast('Draft opened in the canvas. Review each step and save; nothing is saved yet.');
      });
    } });
  }
})();
