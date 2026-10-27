// Chat: agents, tools and skills in a conversation (B-40, console side B-4008). `chat.js` calls App.chatCaps for the
// composer pickers ("/" tools and workflows, "@" agents, "+" skills), the form built from an entry's input schema, the
// tool, approval and run cards of a conversation's invocations, and the skill chips. The routes are
// GET /api/conversations/:id/capabilities and /invocations, POST …/tools, …/agents, …/workflows,
// …/invocations/:iid/decision, /cancel and /held, and PUT and DELETE …/skills/:name; the socket events are
// chat.invocation, chat.skills, run.step, run.state and workflow.run, workflow.step, workflow.approval.
(function () {
  const { UI, esc } = App;
  const K = 'ch-';
  // ===== B-40 core begin =====
  // Agents, tools and skills in chat (B-4007, B-4008): the composer pickers, the form built from a JSON schema, the
  // tool, approval and run cards and the skill chips. The objects have the shape the server gives
  // (GET /api/conversations/:id/capabilities and /invocations), so the board and the console draw them alike.
  const num = (n) => Number(n || 0).toLocaleString('en-US');
  const clock = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const LANES = { think: 'Thinking', do: 'Doing', calc: 'Calculating' };
  const CAPKEY = { tool: 'tools', workflow: 'workflows', agent: 'agents', skill: 'skills' };
  const GROUP = { tool: 'Tools', workflow: 'Workflows', agent: 'Agents', skill: 'Skills' };
  const VERB = { tool: 'call tools', workflow: 'start workflows', agent: 'run agents', skill: 'add skills' };
  const ICON = { tool: 'registry', agent: 'runs', workflow: 'workflows' };
  const KINDTEXT = { tool: 'Tool call', agent: 'Agent run', workflow: 'Workflow run' };
  const sidePill = (s) => (s ? UI.pill(s, s === 'destructive' ? 'danger' : s === 'write' ? 'warn' : 'outline') : '');
  const STATE = {
    pending: ['needs your approval', 'warn'], held: ['held for review', 'warn'], running: ['running', 'info'], waiting: ['waiting on approval', 'info'],
    succeeded: ['done', 'ok'], failed: ['failed', 'danger'], denied: ['denied', 'outline'], rejected: ['rejected', 'danger'], expired: ['expired', 'outline'],
    cancelled: ['cancelled', 'outline'], budget: ['budget stop', 'warn'], blocked: ['blocked', 'danger']
  };
  const statePill = (s) => { const x = STATE[s] || [s, 'outline']; return UI.pill(x[0], x[1]); };
  const versionOf = (kind, v) => (v == null || v === '' ? '' : kind === 'workflow' ? 'v' + v : String(v));
  const activeRun = (inv) => inv.state === 'running' || inv.state === 'waiting';

  const CSS = ('.~pk{border:1px solid var(--line);border-radius:8px;background:var(--panel);box-shadow:var(--shadow);display:flex;flex-direction:column;overflow:hidden}'
    + '.~pkh{display:flex;align-items:center;gap:6px 10px;flex-wrap:wrap;padding:8px 10px 4px}.~pkh .eyebrow{color:var(--fg2)}'
    + '.~pkl{max-height:min(280px,40vh);overflow:auto;padding:4px;display:flex;flex-direction:column}'
    + '.~pkg{padding:6px 8px 2px;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--fg2)}'
    + '.~pko{display:flex;align-items:center;gap:4px 10px;flex-wrap:wrap;padding:6px 8px;border-radius:5px;cursor:pointer;font-size:13px}'
    + '.~pko:hover,.~pko.on{background:var(--sel)}.~pko.on{box-shadow:inset 3px 0 0 var(--accent)}'
    + '.~pko .grow{min-width:0;flex:1 1 180px;display:flex;flex-direction:column;line-height:1.3}.~pko .nm{font-weight:600;overflow-wrap:anywhere}'
    + '.~pko .sub{font-size:12px;color:var(--fg2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.~pko .tags{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap}'
    + '.~pkn{font-size:11px;color:var(--fg2)}.~ver{font-weight:400;color:var(--fg2);font-size:12px}'
    + '.~pke{padding:10px 12px;font-size:13px;color:var(--fg2)}.~pke b{display:block;color:var(--fg)}.~pkf{padding:4px 10px 8px;font-size:11px;color:var(--fg2)}'
    + '.~caps{display:flex;align-items:center;gap:6px;flex-wrap:wrap}'
    + '.~sk{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;min-height:26px;padding:0 2px 0 8px;border:1px solid var(--line);border-radius:13px;background:var(--panel);font-size:12px;max-width:100%}'
    + '.~sk .md{color:var(--fg2)}.~sk.off{border-style:dashed}.~sk.to{border-color:var(--accent)}.~sk .select{height:22px;font-size:12px;max-width:100%}'
    + '.~inv{display:flex;flex-direction:column;gap:10px;padding:12px;border:1px solid var(--line);border-radius:8px;background:var(--panel);font-size:13px;min-width:0}'
    + '.~inv-pending,.~inv-held,.~inv-budget{border-color:var(--warn-fg)}.~inv-waiting{border-color:var(--info-fg);border-style:dashed}.~inv-failed,.~inv-blocked,.~inv-rejected{border-color:var(--danger-fg)}'
    + '.~invh{display:flex;align-items:center;gap:6px 8px;flex-wrap:wrap}.~invh b{overflow-wrap:anywhere}.~invr{margin-left:auto;display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap}'
    + '.~args{margin:0;display:grid;grid-template-columns:minmax(0,max-content) minmax(0,1fr);gap:2px 12px;padding:8px 10px;border:1px solid var(--line2);border-radius:6px;background:var(--bg);font-size:12px}'
    + '.~args dt{color:var(--fg2);overflow-wrap:anywhere}.~args dd{margin:0;overflow-wrap:anywhere;white-space:pre-wrap}'
    + '.~res{margin:0;max-height:220px;overflow:auto;padding:8px 10px;border:1px solid var(--line2);border-radius:6px;background:var(--bg);font-family:var(--mono,monospace);font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere}'
    + '.~note{color:var(--fg2);font-size:12px;overflow-wrap:anywhere}.~acts{display:flex;align-items:center;gap:6px;flex-wrap:wrap}'
    + '.~steps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}.~steps li{display:flex;align-items:center;gap:4px 8px;flex-wrap:wrap;font-size:12px}.~steps .n{min-width:18px;text-align:right;color:var(--fg2)}.~steps .t{overflow-wrap:anywhere}'
    + '.~lane{display:inline-flex;align-items:center;gap:4px;padding:0 6px;border:1px solid var(--line);border-radius:4px;font-weight:600;color:var(--fg2);background:var(--bg)}'
    + '.~bud{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px 14px}'
    + '.~held{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-radius:6px;background:var(--info-bg);color:var(--info-fg);overflow-wrap:anywhere}.~path{font-size:12px}'
    + '.~task{padding-left:10px;border-left:2px solid var(--line);color:var(--fg2);overflow-wrap:anywhere}.~from{font-size:12px;color:var(--fg2)}'
    + '.~form{display:flex;flex-direction:column;gap:12px;min-width:0}.~form[hidden]{display:none}.~form .check{align-items:flex-start}.~inv:focus{outline:2px solid var(--accent);outline-offset:2px}').replace(/~/g, K);

  // ---------- the pickers ----------
  /** What the composer's text asks for: "/" tools and workflows ("/tool", "/workflow" narrow it), "@" agents, "+" skills. */
  function parseTrigger(text) {
    const t = String(text || '');
    if (!/^[\/@+]/.test(t) || t.indexOf('\n') >= 0) return null;
    let q = t.slice(1); let only = null;
    if (t[0] === '/') { const m = /^(tool|workflow)(?:\s+(.*))?$/i.exec(q); if (m) { only = m[1].toLowerCase(); q = m[2] || ''; } }
    return { c: t[0], q: q.trim().toLowerCase(), only };
  }
  function pickerModel(caps, text) {
    const tr = parseTrigger(text); if (!tr || !caps) return null;
    const kinds = tr.c === '/' ? ['tool', 'workflow'].filter((k) => !tr.only || tr.only === k) : [tr.c === '@' ? 'agent' : 'skill'];
    const hit = (e) => !tr.q || (e.name + ' ' + (e.description || '')).toLowerCase().indexOf(tr.q) >= 0;
    const groups = kinds.map((k) => ({ kind: k, label: GROUP[k], all: caps[CAPKEY[k]] || [] }));
    const rows = [];
    groups.forEach((g) => { g.rows = g.all.filter(hit); g.rows.forEach((e) => rows.push({ kind: g.kind, e })); });
    // An ordinary message that happens to start with the character: several words and nothing by that name.
    if (!rows.length && /\s/.test(tr.q)) return null;
    return { tr, kinds, groups: groups.filter((g) => g.rows.length), rows, total: groups.reduce((n, g) => n + g.all.length, 0),
      title: tr.c === '/' ? (tr.only === 'tool' ? 'Tools' : tr.only === 'workflow' ? 'Workflows' : 'Tools and workflows') : tr.c === '@' ? 'Agents' : 'Skills' };
  }
  /** Why the picker lists nothing: no match, no permission, the profile's list, or the conversation's label. */
  function whyEmpty(caps, m) {
    const what = m.kinds.map((k) => GROUP[k].toLowerCase()).join(' or ');
    const one = m.kinds.map((k) => (k === 'agent' ? 'agent' : k)).join(' or ');
    const conv = caps.conversation || {};
    if (m.total && m.tr.q) return ['No ' + one + ' offered here matches "' + m.tr.q + '"', 'One that is not listed is not published here, is above this conversation\'s ceiling, or is not on the profile\'s list.'];
    if (m.kinds.every((k) => caps.may && caps.may[CAPKEY[k]] === false)) return ['Not offered to you', 'Your roles do not let you ' + m.kinds.map((k) => VERB[k]).join(' or ') + ' from a conversation.'];
    if (m.kinds.some((k) => caps.restricted && caps.restricted[CAPKEY[k]])) return ['Nothing on the profile\'s list', 'The profile ' + (conv.profile || 'selected here') + ' names the ' + what + ' it allows, and none of them is published for this conversation.'];
    return ['No ' + what + ' offered here', 'Nothing is published for a conversation labelled ' + (conv.label || 'internal') + '. An entry is offered only while the conversation\'s label is within its ceiling' + (conv.ceiling ? ' (this conversation may reach ' + conv.ceiling + ')' : '') + '.'];
  }
  function pickerHtml(caps, m, active, mode) {
    let i = 0;
    const row = (kind, e) => {
      const n = i++; const on = n === active; const v = versionOf(kind, e.version);
      const tags = (kind === 'tool' ? sidePill(e.sideEffect) + (e.approval === 'caller' ? '<span class="' + K + 'pkn">asks you first</span>' : '') : '')
        + (kind === 'skill' && e.active ? UI.pill(e.active === 'once' ? 'on for the next turn' : 'on', 'ok') : '')
        + (e.deprecated ? UI.pill('deprecated', 'warn') : '')
        + '<span class="' + K + 'pkn">' + (kind === 'workflow' ? 'labelled' : 'up to') + '</span>' + UI.label(kind === 'workflow' ? e.label : e.ceiling, { sm: true });
      return '<div class="' + K + 'pko' + (on ? ' on' : '') + '" role="option" id="' + K + 'pko-' + n + '" aria-selected="' + (on ? 'true' : 'false') + '" data-pko="' + n + '">'
        + '<span class="grow"><span class="nm' + (kind === 'tool' ? ' mono' : '') + '">' + esc(e.name) + (v ? ' <span class="' + K + 'ver">' + esc(v) + '</span>' : '') + '</span><span class="sub">' + esc(e.description || 'No description.') + '</span></span>'
        + '<span class="tags">' + tags + '</span></div>';
    };
    const skill = m.kinds[0] === 'skill';
    let body;
    if (m.rows.length) {
      body = '<div class="' + K + 'pkl" role="listbox" id="' + K + 'pkl" tabindex="0" aria-labelledby="' + K + 'pkt"' + ' aria-activedescendant="' + K + 'pko-' + active + '">'
        + m.groups.map((g) => (m.groups.length > 1 ? '<div role="group" aria-label="' + esc(g.label) + '"><div class="' + K + 'pkg" aria-hidden="true">' + esc(g.label) + '</div>' : '') + g.rows.map((e) => row(g.kind, e)).join('') + (m.groups.length > 1 ? '</div>' : '')).join('') + '</div>'
        + '<div class="' + K + 'pkf">Up and Down move, Enter picks, Esc closes. Typing narrows the list.' + (skill ? ' Shift and Enter adds the skill for the next turn only.' : '') + '</div>';
    } else {
      const why = whyEmpty(caps, m);
      body = '<div class="' + K + 'pke" role="status"><b>' + esc(why[0]) + '</b>' + esc(why[1]) + '</div>';
    }
    return '<div class="' + K + 'pk" id="' + K + 'pk" data-pk><div class="' + K + 'pkh"><span class="eyebrow" id="' + K + 'pkt">' + esc(m.title) + '</span>'
      + (skill && m.rows.length ? '<span class="' + K + 'pkn">Applies</span>' + UI.seg([{ id: 'sticky', label: 'Until removed' }, { id: 'once', label: 'Next turn only' }], mode || 'sticky', 'data-pkmode aria-label="How long the skill applies"') : '')
      + '</div>' + body + '</div>';
  }

  // ---------- a form from a JSON schema ----------
  /** The fields of an object schema, or null when it does not describe an object with properties (then: one JSON box). */
  function schemaFields(schema) {
    const s = schema && typeof schema === 'object' ? schema : null;
    if (!s || (s.type && s.type !== 'object') || (!s.properties && s.type !== 'object')) return null;
    const req = Array.isArray(s.required) ? s.required : [];
    return Object.keys(s.properties || {}).map((name) => {
      const p = s.properties[name] && typeof s.properties[name] === 'object' ? s.properties[name] : {};
      const t = Array.isArray(p.type) ? p.type.filter((x) => x !== 'null')[0] : p.type;
      const en = Array.isArray(p.enum) && p.enum.length && p.enum.every((v) => typeof v === 'string' || typeof v === 'number');
      return { name, p, required: req.indexOf(name) >= 0, kind: en ? 'enum' : t === 'string' || t === 'number' || t === 'integer' || t === 'boolean' ? t : 'json' };
    });
  }
  function formHtml(schema, values) {
    values = values || {};
    const f = schemaFields(schema);
    if (!f) return UI.field('Arguments (JSON)', UI.textarea(JSON.stringify(values, null, 2), { rows: 5, attrs: 'data-arg="" data-argkind="root" spellcheck="false"' }), 'This entry does not describe its arguments as fields, so they are given as one JSON object.');
    if (!f.length) return '<div class="' + K + 'note">It takes no arguments.</div>';
    return f.map((x) => {
      const label = x.name + (x.required ? ' (required)' : '');
      const has = values[x.name] !== undefined ? values[x.name] : x.p.default;
      const a = 'data-arg="' + esc(x.name) + '" data-argkind="' + x.kind + '"' + (x.required ? ' aria-required="true"' : '');
      const hint = [x.p.description || '', x.kind === 'integer' ? 'A whole number.' : x.kind === 'json' ? 'JSON' + (x.p.type ? ' (' + (Array.isArray(x.p.type) ? x.p.type.join(' or ') : x.p.type) + ')' : '') + '.' : ''].filter(Boolean).map(esc).join(' ');
      if (x.kind === 'boolean') return '<div class="field">' + UI.check(label, has === true, a) + (hint ? '<div class="hint">' + hint + '</div>' : '') + '</div>';
      if (x.kind === 'enum') return UI.field(label, UI.select((x.required && has !== undefined ? [] : [{ value: '', label: x.required ? 'Choose one' : 'Not set' }]).concat(x.p.enum.map((v) => ({ value: String(v), label: String(v) }))), has === undefined ? '' : String(has), a), hint);
      if (x.kind === 'number' || x.kind === 'integer') return UI.field(label, UI.input(has === undefined ? '' : String(has), { type: 'number', attrs: a + ' step="' + (x.kind === 'integer' ? '1' : 'any') + '"' + (typeof x.p.minimum === 'number' ? ' min="' + x.p.minimum + '"' : '') + (typeof x.p.maximum === 'number' ? ' max="' + x.p.maximum + '"' : '') }), hint);
      if (x.kind === 'json') return UI.field(label, UI.textarea(has === undefined ? '' : JSON.stringify(has, null, 2), { rows: 3, attrs: a + ' spellcheck="false"' }), hint);
      return UI.field(label, (x.p.maxLength || 0) > 200 ? UI.textarea(has === undefined ? '' : String(has), { rows: 3, attrs: a }) : UI.input(has === undefined ? '' : String(has), { attrs: a }), hint);
    }).join('');
  }
  /** Reads the form back: `{ args }`, or `{ errors }` naming each field that is missing or not what its type asks. */
  function readForm(el, schema) {
    const f = schemaFields(schema); const args = {}; const errors = [];
    const ctl = (name) => Array.prototype.filter.call(el.querySelectorAll('[data-arg]'), (c) => c.dataset.arg === name)[0];
    if (!f) {
      const raw = ctl('');
      try { const v = JSON.parse((raw && raw.value.trim()) || '{}'); if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object'); return { args: v }; } catch (e) { return { errors: ['The arguments are not a JSON object.'] }; }
    }
    f.forEach((x) => {
      const c = ctl(x.name); if (!c) return;
      if (x.kind === 'boolean') { if (c.checked || x.required) args[x.name] = !!c.checked; return; }
      const raw = String(c.value == null ? '' : c.value);
      if (raw.trim() === '') { if (x.required) errors.push(x.name + ' is required.'); return; }
      if (x.kind === 'number' || x.kind === 'integer') { const n = Number(raw); if (!isFinite(n) || (x.kind === 'integer' && Math.floor(n) !== n)) errors.push(x.name + ' must be a ' + (x.kind === 'integer' ? 'whole ' : '') + 'number.'); else args[x.name] = n; return; }
      if (x.kind === 'enum') { const hitv = x.p.enum.filter((v) => String(v) === raw)[0]; args[x.name] = hitv === undefined ? raw : hitv; return; }
      if (x.kind === 'json') { try { args[x.name] = JSON.parse(raw); } catch (e) { errors.push(x.name + ' is not valid JSON.'); } return; }
      args[x.name] = raw;
    });
    return errors.length ? { errors } : { args };
  }

  // ---------- cards ----------
  function argsHtml(inv) {
    if (inv.arguments == null) return '<div class="' + K + 'note">The arguments are above your clearance, so they are not shown.</div>';
    const keys = Object.keys(inv.arguments);
    if (!keys.length) return '<div class="' + K + 'note">No arguments.</div>';
    return '<dl class="' + K + 'args">' + keys.map((k) => { const v = inv.arguments[k]; return '<dt class="mono">' + esc(k) + '</dt><dd class="mono">' + esc(typeof v === 'string' ? v : JSON.stringify(v)) + '</dd>'; }).join('') + '</dl>';
  }
  function resultHtml(inv) {
    if (inv.result == null) return '';
    // 1.7.0: pictures in the result are shown above it (App.chatImages, chat-images.js).
    const pics = App.chatImages ? App.chatImages.html(App.chatImages.collect(inv.result)) : '';
    if (pics) return pics;
    let text = typeof inv.result === 'string' ? inv.result : JSON.stringify(inv.result, null, 2);
    const cut = text.length > 6000; if (cut) text = text.slice(0, 6000);
    return '<div class="' + K + 'res" role="group" tabindex="0" aria-label="Result of ' + esc(inv.name) + '">' + esc(text) + (cut ? '\n…' : '') + '</div>' + (cut ? '<div class="' + K + 'note">Only the first part is shown.</div>' : '');
  }
  function heldHtml(inv, h, i) {
    const last = h.path && h.path.length ? h.path[h.path.length - 1] : null;
    const wf = !!(h.at && h.at.kind === 'workflow-run');
    const path = (h.path || []).map((p) => esc(p.name)).join(' <span aria-hidden="true">›</span> ');
    const at = 'data-inv="' + esc(inv.id) + '" data-fk="' + esc(inv.id) + ':held' + i + ':';
    return '<div class="' + K + 'held"><div><b>' + (wf ? 'Approval needed' : 'Held down the chain' + (last && last.depth != null ? ', depth ' + esc(String(last.depth)) : '')) + '.</b> '
      + (h.tool ? '<span class="mono">' + esc(h.tool) + '</span>' : wf ? 'Step <span class="mono">' + esc(String(h.at.step)) + '</span>' : 'A call') + (h.sideEffect ? ' (' + esc(h.sideEffect) + ')' : '') + (last ? ' in ' + esc(last.name) : '')
      + (h.since ? ', waiting since ' + esc(clock(h.since)) : '') + ' on ' + esc(h.approvers || 'an approver') + '. ' + (wf ? 'The workflow is paused' : 'The whole chain waits') + (h.canDecide ? '; decide it here, from the conversation.' : '.') + '</div>'
      + (path ? '<div class="' + K + 'path">Path: ' + path + '</div>' : '')
      + (h.canDecide ? '<div class="' + K + 'acts">' + UI.btn('Approve', { kind: 'primary', size: 'sm', attrs: 'data-heldok="' + i + '" ' + at + 'ok"' }) + UI.btn('Reject', { size: 'sm', attrs: 'data-heldno="' + i + '" ' + at + 'no"' }) + '</div>' : '') + '</div>';
  }
  function stepsHtml(run) {
    const steps = (run && run.steps) || [];
    if (!steps.length) return '<div class="' + K + 'note">' + (run && run.state === 'queued' ? 'Queued for a worker.' : 'No steps yet.') + '</div>';
    // Agent steps are ok, failed, waiting, denied or rejected; workflow steps queued, running, waiting, passed, failed or skipped.
    const tone = { ok: 'ok', passed: 'ok', failed: 'danger', waiting: 'info', denied: 'danger', rejected: 'danger', running: 'info' };
    return '<ol class="' + K + 'steps" aria-label="Steps">' + steps.map((s) => '<li><span class="n num">' + esc(String(s.n)) + '</span>' + (s.lane ? '<span class="' + K + 'lane">' + UI.icon(s.lane === 'think' ? 'brain' : s.lane === 'calc' ? 'calc' : 'play', 11) + esc(LANES[s.lane] || s.lane) + '</span>' : '')
      + '<span class="t grow">' + esc(s.title || '') + '</span>' + UI.pill(s.state === 'ok' || s.state === 'passed' ? 'done' : s.state, tone[s.state] || 'outline') + '</li>').join('') + '</ol>';
  }
  function budgetsHtml(run) {
    const u = run && run.usage; const b = run && run.budgets; if (!u || !b) return '';
    const m = (label, used, max) => (max ? UI.meter(label, num(used) + ' of ' + num(max), Math.round((100 * (used || 0)) / max), (used || 0) >= max ? 'warn' : '') : '');
    return '<div class="' + K + 'bud">' + m('Steps', u.steps, b.steps) + m('Tokens', u.tokens, b.tokens) + m('Tool calls', u.toolCalls, b.toolCalls) + '</div>';
  }
  /**
   * One invocation as a card. `d.answer` is the agent's answer (the assistant message's content), `d.rich` renders it,
   * `d.canAct` is false for a reader who may not decide (the buttons are left out), `d.flags` whether Flags is open to them.
   */
  function cardHtml(inv, d) {
    d = d || {};
    const run = inv.run; const ap = inv.approval || {}; const act = d.canAct !== false;
    const at = (a) => 'data-inv="' + esc(inv.id) + '" data-fk="' + esc(inv.id) + ':' + a + '"';
    const v = versionOf(inv.kind, inv.version);
    const note = (html) => '<div class="' + K + 'note">' + html + '</div>';
    let h = '<div class="' + K + 'inv ' + K + 'inv-' + esc(inv.state) + '" role="group" aria-label="' + esc(KINDTEXT[inv.kind] + ': ' + inv.name) + '" data-invcard="' + esc(inv.id) + '">'
      + '<div class="' + K + 'invh">' + UI.icon(ICON[inv.kind] || 'registry', 14) + '<b' + (inv.kind === 'tool' ? ' class="mono"' : '') + '>' + esc(inv.name) + '</b>' + (v ? '<span class="' + K + 'ver">' + esc(v) + '</span>' : '')
      + (inv.kind === 'tool' ? sidePill(inv.sideEffect) : '<span class="' + K + 'pkn">' + (inv.kind === 'agent' ? 'agent run' : 'workflow run') + '</span>')
      + '<span class="' + K + 'invr">' + (inv.example ? '<span class="' + K + 'pkn">example</span>' : '') + statePill(inv.state) + UI.label(inv.label, { sm: true }) + '</span></div>';
    if (inv.kind === 'agent') h += inv.input ? '<div class="' + K + 'task">' + esc(inv.input) + '</div>' : '';
    else h += (inv.fromText ? note('The profile turned your words into these arguments. Check them: this is exactly what the tool receives.') : '') + argsHtml(inv);

    if (inv.kind === 'tool') {
      const reviewer = (ap.needs || []).indexOf('reviewer') >= 0;
      if (inv.state === 'pending') {
        h += note(inv.sideEffect === 'destructive'
          ? '<b>A destructive call.</b> It cannot be undone. Nothing has run. It runs as you on your approval' + (reviewer ? ', and a rule also sends it to a reviewer in the flag queue before it runs.' : '; when a guardrail rule says so, a reviewer also decides in the flag queue before it runs.')
          : 'Nothing has run. ' + (inv.sideEffect === 'write' ? 'This tool writes. ' : '') + 'It runs as you once you approve' + (reviewer ? ', and a rule also sends it to a reviewer in the flag queue.' : '.'))
          + (ap.expiresAt ? note('The card expires at ' + esc(clock(ap.expiresAt)) + ' if nobody decides.') : '')
          + (act ? '<div class="' + K + 'acts">' + UI.btn('Approve', { kind: 'primary', size: 'sm', attrs: 'data-invok ' + at('ok') }) + UI.btn('Deny', { size: 'sm', attrs: 'data-invno ' + at('no') }) + '</div>' : '');
      } else if (inv.state === 'held') {
        h += '<div class="' + K + 'held" role="status"><div><b>Held for review.</b> ' + esc(ap.reason || 'A tool-call guardrail rule asks a reviewer to decide this call.') + ' A reviewer other than you approves or rejects it in the flag queue. Nothing has run.</div>'
          + (ap.flag ? '<div class="' + K + 'path">Flag ' + (d.flags ? '<a href="#/flags?id=' + encodeURIComponent(ap.flag) + '" class="mono" data-goflag="' + esc(ap.flag) + '">' + esc(ap.flag) + '</a>' : '<span class="mono">' + esc(ap.flag) + '</span>') + (ap.caller && ap.caller.decision === 'approved' ? ', after your own approval at ' + esc(clock(ap.caller.at)) : '') + '.</div>' : '') + '</div>'
          + (act ? '<div class="' + K + 'acts">' + UI.btn('Withdraw the call', { size: 'sm', attrs: 'data-invcancel ' + at('cancel') }) + '</div>' : '');
      } else if (inv.state === 'running') h += '<div class="' + K + 'note" role="status">Calling the tool. The result appears here.</div>';
      else if (inv.state === 'succeeded') h += resultHtml(inv) + note((ap.reviewer && ap.reviewer.decision === 'approved' ? 'Approved by ' + esc(ap.reviewer.by || 'a reviewer') + '. ' : ap.caller && ap.caller.decision === 'approved' ? 'Ran on your approval. ' : '') + 'The model sees this call and its result on the next turn.');
      else if (inv.state === 'failed') h += UI.notice('<b>The call failed.</b> ' + esc(inv.error || 'No detail was recorded.'), 'danger');
      else if (inv.state === 'denied') h += note('You denied this call. Nothing ran, and the denial is recorded.');
      else if (inv.state === 'rejected') h += note('Rejected by ' + esc((ap.reviewer && ap.reviewer.by) || 'a reviewer') + (ap.flag ? ' on flag <span class="mono">' + esc(ap.flag) + '</span>' : '') + '. Nothing ran.');
      else if (inv.state === 'expired') h += note('Nobody decided before ' + (ap.expiresAt ? esc(clock(ap.expiresAt)) : 'the card expired') + '. Nothing ran. Call the tool again if it is still needed.');
      else if (inv.state === 'cancelled') h += note('Withdrawn before it ran. Nothing ran.');
      else if (inv.state === 'blocked') h += UI.notice('<b>Blocked by the tool-call guardrail.</b> ' + esc(ap.reason || inv.error || '') + ' Nothing ran.', 'danger');
    } else {
      const wf = inv.kind === 'workflow';
      h += stepsHtml(run) + (wf ? '' : budgetsHtml(run));
      h += (inv.held || []).map((x, i) => (act || !x.canDecide ? heldHtml(inv, x, i) : heldHtml(inv, Object.assign({}, x, { canDecide: false }), i))).join('');
      if (inv.state === 'waiting' && !(inv.held || []).length) h += note('Waiting on an approval in its chain.');
      if (inv.state === 'budget') h += UI.notice('<b>Budget stop.</b> ' + esc(inv.error || 'The run reached a limit.') + ' The last checkpoint is kept; raise the limit in Runs to resume it, or cancel it here.', 'warn');
      if (inv.state === 'failed') h += UI.notice('<b>The run failed.</b> ' + esc(inv.error || 'No detail was recorded.'), 'danger');
      if (inv.state === 'cancelled') h += note('Cancelled. The steps so far are kept in ' + (wf ? 'Workflows' : 'Runs') + '.');
      if (inv.state === 'rejected') h += note('An approval in the chain was rejected, so the run ended without its result.' + (inv.error ? ' ' + esc(inv.error) : ''));
      if (wf && inv.state === 'succeeded') h += resultHtml(inv);
      const answer = d.answer != null ? d.answer : inv.answer;
      if (!wf && inv.state === 'succeeded' && answer) h += '<div class="' + K + 'from">Answer from <b>' + esc(inv.name) + '</b>' + (v ? ' ' + esc(v) : '') + '</div><div class="' + K + 'answer answer serif">' + (d.rich ? d.rich(answer) : esc(answer)) + '</div>';
      if (run) {
        h += '<div class="' + K + 'acts">' + (act && (activeRun(inv) || inv.state === 'budget') ? UI.btn(wf ? 'Cancel the workflow run' : 'Cancel run', { size: 'sm', attrs: 'data-invcancel ' + at('cancel') }) : '')
          + (run.id ? '<a class="btn sm" href="' + (wf ? '#/workflows?run=' : '#/runs?run=') + encodeURIComponent(run.id) + '" ' + at('open') + ' data-openrun="' + esc(run.id) + '">' + (wf ? 'Open in Workflows' : 'Open in Runs') + '</a>' : '')
          + (run.chain ? '<a class="btn sm ghost" href="#/runs?chain=' + encodeURIComponent(run.chain) + '" ' + at('chain') + ' data-openchain="' + esc(run.chain) + '">Open the chain tree</a>' : '') + '</div>';
      }
    }
    return h + '</div>';
  }

  // ---------- skill chips and the agent the next message goes to ----------
  function capsBarHtml(o) {
    const skills = o.skills || []; const t = o.target;
    let h = '';
    if (t) {
      h += '<span class="' + K + 'sk to">' + UI.icon('runs', 12) + '<span>To <b>' + esc(t.name) + '</b>' + (t.version ? ' ' + esc(t.version) : '') + '</span>'
        + UI.select([{ value: '0', label: 'reads no earlier turns' }, { value: '2', label: 'reads the last 2 turns' }, { value: '6', label: 'reads the last 6 turns' }, { value: '20', label: 'reads the last 20 turns' }], String(t.context || 0), 'data-tocontext aria-label="Earlier turns ' + esc(t.name) + ' may read"')
        + UI.iconbtn('x', 'Send to the model instead of ' + t.name, { cls: 'sm ghost', attrs: 'data-tooff' }) + '</span>';
    }
    h += skills.map((s) => '<span class="' + K + 'sk' + (s.available === false ? ' off' : '') + '" data-skill="' + esc(s.name) + '">' + UI.icon('brain', 12) + '<span><b>' + esc(s.name) + '</b>' + (s.version ? ' ' + esc(s.version) : '') + '</span><span class="md">'
      + (s.available === false ? 'not applied' + (s.reason ? ': ' + esc(s.reason) : '') : s.mode === 'once' ? 'next turn only' : 'sticky') + '</span>' + (o.canEdit === false ? '' : UI.iconbtn('x', 'Remove the skill ' + s.name, { cls: 'sm ghost', attrs: 'data-rmskill="' + esc(s.name) + '"' })) + '</span>').join('');
    if (o.canEdit !== false) {
      h += UI.chip('/ tool', false, 'data-trigger="/" title="Call a tool or start a workflow"') + UI.chip('@ agent', false, 'data-trigger="@" title="Send the next message to an agent"') + UI.chip('+ skill', false, 'data-trigger="+" title="Add a skill to this conversation"');
    }
    return h;
  }
  /** "@Data analyst how far over is travel?": the longest agent name the text starts with, and the rest. */
  function agentPrefix(caps, text) {
    const t = String(text || ''); if (t[0] !== '@' || !caps) return null;
    const low = t.slice(1).toLowerCase(); let best = null;
    (caps.agents || []).forEach((a) => { const n = a.name.toLowerCase(); if (low.indexOf(n) === 0 && (low.length === n.length || /\s/.test(low[n.length])) && (!best || n.length > best.name.length)) best = a; });
    return best ? { agent: best, input: t.slice(1 + best.name.length).trim() } : null;
  }

  // ---------- example data (the board's states, and the console's design states) ----------
  const EXCAPS = () => ({
    conversation: { id: null, label: 'confidential', ceiling: 'confidential', profile: 'analyst' },
    may: { tools: true, agents: true, skills: true, workflows: true }, restricted: { tools: false, agents: false, skills: true, workflows: false },
    tools: [
      { id: 't1', name: 'ledger.query', version: '2.1.0', description: 'Reads rows from the finance ledger for a quarter and an account.', impl: 'mcp', sideEffect: 'read', confirm: 'never', ceiling: 'confidential', approval: 'none', deprecated: false,
        inputSchema: { type: 'object', properties: { quarter: { type: 'string', enum: ['Q1', 'Q2', 'Q3', 'Q4'], description: 'The quarter of this financial year.' }, account: { type: 'string', description: 'Account or cost centre, for example travel or FIELD-SALES.' }, limit: { type: 'integer', description: 'How many rows to return at most.', default: 50, minimum: 1, maximum: 500 }, includeDrafts: { type: 'boolean', description: 'Also return entries that are not posted yet.' } }, required: ['quarter', 'account'] } },
      { id: 't2', name: 'jira.create_issue', version: '1.0.0', description: 'Creates an issue in jira-internal as you.', impl: 'mcp', sideEffect: 'write', confirm: 'always', ceiling: 'confidential', approval: 'caller', deprecated: false,
        inputSchema: { type: 'object', properties: { project: { type: 'string', enum: ['FIN', 'OPS', 'LEGAL'], description: 'The project key.' }, summary: { type: 'string', description: 'One line that says what the issue is about.' }, description: { type: 'string', maxLength: 4000, description: 'What happened and what is asked for.' }, priority: { type: 'string', enum: ['low', 'medium', 'high'], default: 'medium' }, labels: { type: 'array', items: { type: 'string' }, description: 'A list of labels, for example ["q3", "travel"].' } }, required: ['project', 'summary'] } },
      { id: 't3', name: 'ledger.void_entry', version: '1.2.0', description: 'Voids a posted ledger entry. It cannot be undone.', impl: 'mcp', sideEffect: 'destructive', confirm: 'always', ceiling: 'confidential', approval: 'caller', deprecated: false,
        inputSchema: { type: 'object', properties: { entry: { type: 'string', description: 'The entry number, for example LE-2025-09-0412.' }, reason: { type: 'string', description: 'Why it is voided; kept with the audit record.' } }, required: ['entry', 'reason'] } },
      { id: 't4', name: 'calculate', version: '1.0.0', description: 'Evaluates an expression exactly on the calculation worker.', impl: 'builtin', sideEffect: 'read', confirm: 'never', ceiling: 'restricted', approval: 'none', deprecated: false,
        inputSchema: { type: 'object', properties: { expression: { type: 'string', description: 'For example (412880 - 361500) / 361500.' } }, required: ['expression'] } }
    ],
    agents: [
      { id: 'a1', name: 'Data analyst', version: '1.0.0', description: 'Answers questions over the ledger and the Finance KB, with exact calculation.', ceiling: 'confidential', profile: 'analyst', budgets: { steps: 20, tokens: 10000, wallSeconds: 120, toolCalls: 8 }, inputSchema: null, deprecated: false },
      { id: 'a2', name: 'Travel desk', version: '1.0.0', description: 'Answers questions about bookings and the travel policy.', ceiling: 'internal', profile: 'chat-default', budgets: { steps: 10, tokens: 6000, wallSeconds: 60, toolCalls: 4 }, inputSchema: null, deprecated: false },
      { id: 'a3', name: 'Contract reader', version: '0.9.0', description: 'Reads a contract and lists its terms, notice periods and caps.', ceiling: 'confidential', profile: 'analyst', budgets: { steps: 12, tokens: 12000, wallSeconds: 180, toolCalls: 4 }, inputSchema: null, deprecated: false }
    ],
    skills: [
      { id: 's1', name: 'house-style', version: '1.0.0', description: 'Plain sentences, EUR net of VAT, dates as 12 September 2025.', ceiling: 'restricted', tools: [], active: null },
      { id: 's2', name: 'finance-glossary', version: '2.0.0', description: 'The cost centre names and what each ledger account covers.', ceiling: 'confidential', tools: ['ledger.query'], active: null },
      { id: 's3', name: 'cite-the-policy', version: '1.1.0', description: 'Every claim about policy names its section of the Travel policy.', ceiling: 'internal', tools: [], active: null }
    ],
    workflows: [
      { id: 'w1', name: 'quarterly-variance', version: 1, description: 'Ledger query, exact calculation, a draft, then an approval before it is filed.', label: 'confidential', inputSchema: { type: 'object', properties: { quarter: { type: 'string', enum: ['Q1', 'Q2', 'Q3', 'Q4'] }, costCentre: { type: 'string', description: 'Leave empty for every cost centre.' } }, required: ['quarter'] } },
      { id: 'w2', name: 'contract-redline', version: 2, description: 'Compares a contract with the template and drafts the redline.', label: 'internal', inputSchema: { type: 'object', properties: { contract: { type: 'string', description: 'The document name in the Contracts KB.' } }, required: ['contract'] } }
    ]
  });
  const EXRESULT = {
    'ledger.query': { rows: [{ cost_centre: 'FIELD-SALES', q3_actual: 188420, q3_budget: 150000 }, { cost_centre: 'LIS-ONBOARD', q3_actual: 96310, q3_budget: 60000 }], total: 14 },
    'jira.create_issue': { key: 'FIN-1187', url: 'https://jira-internal/browse/FIN-1187' }, 'ledger.void_entry': { voided: 'LE-2025-09-0412' }, calculate: { decimal: '0.1421', exact: false },
    'quarterly-variance': { filed: 'Q3 variance note, version 1', overrun: '14.2%' }, 'contract-redline': { draft: 'Fabrikam MSA 2025, redline 1' }
  };
  const EXANSWER = 'Travel was 14.2% over budget in Q3: 412,880 EUR against 361,500 EUR. Field Sales and the Lisbon onboarding programme account for most of it, and the approved Lisbon exception covers 38,000 EUR of the difference.';
  let exSeq = 0;
  /** An example invocation in the server's shape. `say` is the caller's line above the card. */
  function example(which) {
    const now = Date.now();
    const base = { id: 'example-' + (++exSeq), example: true, label: 'confidential', sideEffect: null, arguments: null, input: null, fromText: false, result: null, error: null, approval: null, run: null, held: [], createdAt: now, updatedAt: now };
    const tool = (name, version, side, args, state, more) => Object.assign(base, { kind: 'tool', name, version, sideEffect: side, arguments: args, state, say: '/' + name + ' ' + Object.keys(args).map((k) => k + '=' + args[k]).join(' ') }, more || {});
    const query = { quarter: 'Q3', account: 'travel', limit: 50 };
    const issue = { project: 'FIN', summary: 'Q3 travel overrun review', priority: 'medium' };
    const voidArgs = { entry: 'LE-2025-09-0412', reason: 'Posted twice by the card feed' };
    const caller = (decision) => ({ decision, at: now - 60000 });
    const steps = (list) => list.map((s, i) => ({ n: i + 1, lane: s[0], title: s[1], state: s[2] || 'ok' }));
    const agent = (state, st, usage, more) => Object.assign(base, { kind: 'agent', name: 'Data analyst', version: '1.0.0', state, input: 'How far over budget was travel in Q3, and what explains it?', say: '@Data analyst How far over budget was travel in Q3, and what explains it?',
      run: { kind: 'agent-run', id: '01K7RUN7F3A', state: state === 'succeeded' ? 'succeeded' : state, chain: '01K7CHAIN9C2E', usage, budgets: { steps: 20, tokens: 10000, wallSeconds: 120, toolCalls: 8 }, steps: steps(st) } }, more || {});
    switch (which) {
      case 'toolRunning': return tool('ledger.query', '2.1.0', 'read', query, 'running');
      case 'toolDone': return tool('ledger.query', '2.1.0', 'read', query, 'succeeded', { result: EXRESULT['ledger.query'] });
      case 'toolFailed': return tool('ledger.query', '2.1.0', 'read', query, 'failed', { error: 'The ledger connection timed out after 10 s. Nothing was changed.' });
      case 'fromText': return tool('jira.create_issue', '1.0.0', 'write', issue, 'pending', { fromText: true, say: '/jira.create_issue file an issue in FIN about the Q3 travel overrun review', approval: { needs: ['caller'], caller: null, reviewer: null, flag: null, reason: null, expiresAt: now + 15 * 60000 } });
      case 'pending': return tool('jira.create_issue', '1.0.0', 'write', issue, 'pending', { approval: { needs: ['caller'], caller: null, reviewer: null, flag: null, reason: null, expiresAt: now + 15 * 60000 } });
      case 'destructive': return tool('ledger.void_entry', '1.2.0', 'destructive', voidArgs, 'pending', { approval: { needs: ['caller', 'reviewer'], caller: null, reviewer: null, flag: null, reason: null, expiresAt: now + 15 * 60000 } });
      case 'held': return tool('ledger.void_entry', '1.2.0', 'destructive', voidArgs, 'held', { approval: { needs: ['caller', 'reviewer'], caller: caller('approved'), reviewer: null, flag: 'F-2301', reason: 'Rule void-needs-a-second-person: voiding a ledger entry needs a reviewer.', expiresAt: now + 24 * 3600000 } });
      case 'denied': return tool('jira.create_issue', '1.0.0', 'write', issue, 'denied', { approval: { needs: ['caller'], caller: caller('denied'), reviewer: null, flag: null, reason: null, expiresAt: null } });
      case 'expired': return tool('jira.create_issue', '1.0.0', 'write', issue, 'expired', { approval: { needs: ['caller'], caller: null, reviewer: null, flag: null, reason: null, expiresAt: now - 5 * 60000 } });
      case 'rejected': return tool('ledger.void_entry', '1.2.0', 'destructive', voidArgs, 'rejected', { approval: { needs: ['caller', 'reviewer'], caller: caller('approved'), reviewer: { decision: 'rejected', by: 'Dana Reyes', at: now - 30000 }, flag: 'F-2301', reason: null, expiresAt: null } });
      case 'blocked': return tool('ledger.void_entry', '1.2.0', 'destructive', voidArgs, 'blocked', { approval: { needs: [], caller: null, reviewer: null, flag: null, reason: 'Rule no-voids-in-close-week: ledger entries are not voided while the quarter is closing.', expiresAt: null } });
      case 'agentRunning': return agent('running', [['think', 'Plan the query'], ['do', 'ledger.query']], { steps: 2, tokens: 640, toolCalls: 1 });
      case 'agentWaiting': return agent('waiting', [['think', 'Plan the query'], ['do', 'ledger.query'], ['calc', '(412880 - 361500) / 361500'], ['do', 'agent: Ledger clerk', 'waiting']], { steps: 4, tokens: 2210, toolCalls: 2 },
        { held: [{ node: '01K7NODE3', path: [{ kind: 'agent-run', name: 'Data analyst', depth: 0 }, { kind: 'agent-run', name: 'Ledger clerk', depth: 1 }], at: { kind: 'agent-run', run: '01K7RUN81B2', step: 2 }, tool: 'jira.create_issue', sideEffect: 'write', since: now - 4 * 60000, approvers: 'the run\'s owner or a tool admin', canDecide: true }] });
      case 'agentBudget': return agent('budget', [['think', 'Plan the query'], ['do', 'ledger.query'], ['think', 'Read 14 rows'], ['do', 'ledger.query'], ['think', 'Compare with the budget']], { steps: 5, tokens: 10000, toolCalls: 2 }, { error: 'The run reached its token limit of 10,000.' });
      case 'agentDone': return agent('succeeded', [['think', 'Plan the query'], ['do', 'ledger.query'], ['calc', '(412880 - 361500) / 361500'], ['think', 'Write the answer']], { steps: 4, tokens: 2904, toolCalls: 1 }, { answer: EXANSWER });
      case 'workflowWaiting': case 'workflowDone': {
        const done = which === 'workflowDone';
        return Object.assign(base, { kind: 'workflow', name: 'quarterly-variance', version: 1, state: done ? 'succeeded' : 'waiting', arguments: { quarter: 'Q3' }, say: '/workflow quarterly-variance quarter=Q3', result: done ? EXRESULT['quarterly-variance'] : null,
          run: { kind: 'workflow-run', id: '01K7WFRUN55', state: done ? 'succeeded' : 'waiting', chain: '01K7CHAIN4D10', usage: null, budgets: null, steps: [{ n: 1, lane: 'do', title: 'Ledger query', state: 'passed' }, { n: 2, lane: 'do', title: 'Calculate the variance', state: 'passed' }, { n: 3, lane: 'do', title: 'Draft the note', state: 'passed' }, { n: 4, lane: 'do', title: 'Approve before filing', state: done ? 'passed' : 'waiting' }] },
          held: done ? [] : [{ node: '01K7NODE8', path: [{ kind: 'workflow-run', name: 'quarterly-variance', depth: 0 }], at: { kind: 'workflow-run', run: '01K7WFRUN55', approval: '01K7APPR1', step: 'approve' }, tool: null, sideEffect: null, since: now - 2 * 60000, approvers: 'the finance controller role', canDecide: true }] });
      }
      default: return tool('ledger.query', '2.1.0', 'read', query, 'running');
    }
  }
  /** Example invocations made from the board's (or a design state's) own picker: nothing is called. */
  function argsFromText(e, text) {
    const out = {}; (schemaFields(e.inputSchema) || []).forEach((x) => { if (!x.required) return; out[x.name] = x.kind === 'enum' ? x.p.enum[0] : x.kind === 'boolean' ? true : x.kind === 'number' || x.kind === 'integer' ? 1 : text; });
    return out;
  }
  function exampleCall(e, payload) {
    const args = payload.arguments || argsFromText(e, payload.text);
    const asks = e.approval === 'caller' || !!payload.text;
    return Object.assign(example('toolRunning'), { name: e.name, version: e.version, sideEffect: e.sideEffect, arguments: args, fromText: !!payload.text, state: asks ? 'pending' : 'running',
      say: '/' + e.name + ' ' + (payload.text || Object.keys(args).map((k) => k + '=' + (typeof args[k] === 'string' ? args[k] : JSON.stringify(args[k]))).join(' ')),
      approval: asks ? { needs: e.sideEffect === 'destructive' ? ['caller', 'reviewer'] : ['caller'], caller: null, reviewer: null, flag: null, reason: null, expiresAt: Date.now() + 15 * 60000 } : null });
  }
  function exampleWorkflow(e, payload) {
    const a = payload.arguments || {};
    const inv = Object.assign(example('workflowWaiting'), { name: e.name, version: e.version, label: e.label, state: 'running', arguments: a, held: [], say: '/workflow ' + e.name + ' ' + Object.keys(a).map((k) => k + '=' + a[k]).join(' ') });
    inv.run.steps = []; inv.run.state = 'running';
    return inv;
  }
  function exampleAgent(a, input) {
    const inv = Object.assign(example('agentRunning'), { name: a.name, version: a.version, input, say: '@' + a.name + ' ' + input });
    inv.run.steps = []; inv.run.usage = { steps: 0, tokens: 0, toolCalls: 0 }; inv.run.budgets = a.budgets;
    return inv;
  }
  /**
   * Example cards change on the page only; nothing is called. `repaint(inv)` redraws the card after each change.
   * action: 'run' (a read tool) | 'approve' | 'deny' | 'cancel' | 'held' (with { i, decision }) | 'play' (a run whose steps arrive one by one).
   */
  function exampleAct(inv, action, arg, repaint) {
    const later = (ms, fn) => setTimeout(() => { fn(); inv.updatedAt = Date.now(); repaint(inv); }, ms);
    const finish = () => { inv.state = 'succeeded'; if (inv.run) inv.run.state = 'succeeded'; if (inv.kind === 'agent') inv.answer = EXANSWER; else inv.result = EXRESULT[inv.name] || { ok: true }; };
    if (action === 'approve') {
      inv.approval = Object.assign({}, inv.approval, { caller: { decision: 'approved', at: Date.now() } });
      if ((inv.approval.needs || []).indexOf('reviewer') >= 0) { inv.state = 'held'; inv.approval.flag = inv.approval.flag || 'F-2301'; inv.approval.reason = inv.approval.reason || 'Rule void-needs-a-second-person: voiding a ledger entry needs a reviewer.'; }
      else { inv.state = 'running'; later(900, finish); }
    } else if (action === 'deny') { inv.state = 'denied'; inv.approval = Object.assign({}, inv.approval, { caller: { decision: 'denied', at: Date.now() } }); }
    else if (action === 'run') { inv.state = 'running'; later(900, finish); }
    else if (action === 'cancel') { inv.state = 'cancelled'; inv.held = []; if (inv.run) { inv.run.state = 'cancelled'; inv.run.steps.forEach((s) => { if (s.state === 'waiting') s.state = 'denied'; }); } }
    else if (action === 'held') {
      inv.held.splice(arg.i, 1);
      const s = inv.run && inv.run.steps.filter((x) => x.state === 'waiting')[0]; if (s) s.state = arg.decision !== 'approve' ? (inv.kind === 'workflow' ? 'failed' : 'rejected') : inv.kind === 'workflow' ? 'passed' : 'ok';
      inv.state = 'running'; if (inv.run) inv.run.state = 'running';
      if (inv.kind === 'workflow' && arg.decision !== 'approve') { inv.state = 'rejected'; inv.run.state = 'rejected'; inv.error = 'The approval was rejected, so nothing was filed.'; inv.updatedAt = Date.now(); repaint(inv); return; }
      later(900, () => { if (inv.kind === 'agent') { inv.run.steps.push({ n: inv.run.steps.length + 1, lane: 'think', title: 'Write the answer', state: 'ok' }); if (inv.run.usage) inv.run.usage.steps = inv.run.steps.length; } finish(); });
    } else if (action === 'play') {
      const script = inv.kind === 'agent' ? [['think', 'Plan the query'], ['do', 'ledger.query'], ['calc', '(412880 - 361500) / 361500'], ['think', 'Write the answer']] : [['do', 'Ledger query'], ['do', 'Calculate the variance'], ['do', 'Draft the note'], ['do', 'Approve before filing']];
      const next = () => {
        const n = inv.run.steps.length;
        if (inv.state !== 'running') return;
        if (n >= script.length) { finish(); return; }
        const last = inv.kind === 'workflow' && n === script.length - 1;
        inv.run.steps.push({ n: n + 1, lane: script[n][0], title: script[n][1], state: last ? 'waiting' : inv.kind === 'workflow' ? 'passed' : 'ok' });
        if (inv.run.usage) { inv.run.usage.steps = n + 1; inv.run.usage.tokens += script[n][0] === 'think' ? 700 : 40; if (script[n][0] === 'do') inv.run.usage.toolCalls += 1; }
        if (last) { inv.state = 'waiting'; inv.run.state = 'waiting'; inv.held = [{ node: 'example-node', path: [{ kind: 'workflow-run', name: inv.name, depth: 0 }], at: { kind: 'workflow-run', run: inv.run.id, approval: 'example-approval', step: 'approve' }, tool: null, sideEffect: null, since: Date.now(), approvers: 'the finance controller role', canDecide: true }]; return; }
        later(700, next);
      };
      later(600, next);
      return;
    }
    inv.updatedAt = Date.now(); repaint(inv);
  }
  // ---------- the picker over the composer ----------
  /**
   * The composer is an ARIA combobox while the picker is open (the attributes are set on open and removed on close, so
   * it is a plain multi-line text box the rest of the time). Focus stays in the textarea; Up and Down move
   * aria-activedescendant through the list box, Enter picks, Esc closes, typing narrows.
   * o: { composer(), host(), caps(), state(), pick(row, mode), pending() }.
   */
  function pickerControl(o) {
    const ARIA = ['role', 'aria-expanded', 'aria-controls', 'aria-haspopup', 'aria-autocomplete', 'aria-activedescendant'];
    const model = () => { const ta = o.composer(); const pk = o.state(); return !ta || pk.dismissed ? null : pickerModel(o.caps(), ta.value); };
    function paint() {
      const ta = o.composer(); const host = o.host(); const pk = o.state(); if (!ta || !host) return;
      const m = model();
      if (!m) {
        const wait = !pk.dismissed && parseTrigger(ta.value) && !o.caps() && o.pending ? o.pending() : '';
        if (host._html !== wait) { host.innerHTML = wait; host._html = wait; }
        ARIA.forEach((a) => ta.removeAttribute(a));
        return;
      }
      const inList = document.activeElement && document.activeElement.id === K + 'pkl';
      pk.active = Math.max(0, Math.min(pk.active || 0, m.rows.length - 1));
      const html = pickerHtml(o.caps(), m, pk.active, pk.mode);
      if (host._html !== html || !host.firstChild) { host.innerHTML = html; host._html = html; }
      ta.setAttribute('role', 'combobox'); ta.setAttribute('aria-expanded', 'true'); ta.setAttribute('aria-controls', K + 'pk'); ta.setAttribute('aria-haspopup', 'listbox'); ta.setAttribute('aria-autocomplete', 'list');
      if (m.rows.length) {
        ta.setAttribute('aria-activedescendant', K + 'pko-' + pk.active);
        const on = host.querySelector('#' + K + 'pko-' + pk.active); if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
        if (inList) { const l = host.querySelector('#' + K + 'pkl'); if (l) l.focus(); }
      } else ta.removeAttribute('aria-activedescendant');
    }
    /** True when the key was the picker's (the composer must not also send on Enter). */
    function key(e) {
      const m = model(); const pk = o.state(); if (!m) return false;
      if (e.key === 'Escape') { pk.dismissed = true; paint(); const ta = o.composer(); if (ta) ta.focus(); e.preventDefault(); e.stopPropagation(); return true; }
      if (!m.rows.length) return false;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { pk.active = (pk.active + (e.key === 'ArrowDown' ? 1 : m.rows.length - 1)) % m.rows.length; paint(); e.preventDefault(); return true; }
      if (e.key === 'Home' && e.target.id === K + 'pkl') { pk.active = 0; paint(); e.preventDefault(); return true; }
      if (e.key === 'End' && e.target.id === K + 'pkl') { pk.active = m.rows.length - 1; paint(); e.preventDefault(); return true; }
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); o.pick(m.rows[pk.active], m.kinds[0] === 'skill' && e.shiftKey ? 'once' : pk.mode || 'sticky'); return true; }
      return false;
    }
    function input() { const ta = o.composer(); const pk = o.state(); pk.active = 0; if (!ta || !parseTrigger(ta.value)) pk.dismissed = false; paint(); }
    /** Puts the trigger character in the composer and opens the picker (the "/ tool", "@ agent" and "+ skill" buttons). */
    function open(c) { const ta = o.composer(); const pk = o.state(); if (!ta || ta.disabled) return; ta.value = c; pk.dismissed = false; pk.active = 0; ta.focus(); try { ta.setSelectionRange(1, 1); } catch (e) { /* not focusable */ } paint(); }
    /** Clicks inside the picker: an option picks it, the skill mode buttons switch how long a skill applies. */
    function click(e) {
      const pk = o.state(); const seg = e.target.closest('[data-pkmode] [data-seg]');
      if (seg) { pk.mode = seg.dataset.seg; paint(); const ta = o.composer(); if (ta) ta.focus(); return; }
      const opt = e.target.closest('[data-pko]'); const m = model();
      if (opt && m && m.rows[Number(opt.dataset.pko)]) o.pick(m.rows[Number(opt.dataset.pko)], pk.mode || 'sticky');
    }
    return { model, paint, key, input, open, click };
  }

  // ---------- the tool and workflow form ----------
  /**
   * The dialog for a tool call or a workflow start: a form from the entry's input schema, or (tools) words the profile
   * turns into arguments. o: { kind, entry, profile, canText, values, submit(payload) → Promise }. The dialog stays open
   * and says why when `submit` rejects; it closes when it resolves.
   */
  function openForm(ctx, o) {
    const e = o.entry; const tool = o.kind === 'tool'; const asks = tool && e.approval === 'caller';
    const v = versionOf(o.kind, e.version);
    const local = { tab: o.startWithText && o.canText ? 'text' : 'form' };
    const okLabel = () => (!tool ? 'Start the workflow' : local.tab === 'text' ? 'Turn it into arguments' : asks ? 'Show the approval card' : 'Call the tool');
    const how = !tool ? 'The run joins this conversation as a card with its steps. Its approvals appear on that card.'
      : asks ? 'This tool ' + (e.sideEffect === 'destructive' ? 'is destructive' : e.sideEffect === 'write' ? 'writes' : 'always asks first') + '. Nothing runs until you approve the card that appears in the conversation' + (e.sideEffect === 'destructive' ? '; when a guardrail rule says so, a reviewer also decides.' : '.')
        : 'A read tool: it runs at once as you, and its result joins the conversation, where the model sees it on the next turn.';
    ctx.modal({
      title: (tool ? 'Call ' : 'Start ') + '<span class="' + (tool ? 'mono' : '') + '">' + esc(e.name) + '</span>' + (v ? ' <span class="' + K + 'ver">' + esc(v) + '</span>' : '') + (tool ? ' ' + sidePill(e.sideEffect) : ''),
      body: '<div class="fg2">' + esc(e.description || '') + '</div>'
        + (tool && o.canText ? UI.seg([{ id: 'form', label: 'Fill the form' }, { id: 'text', label: 'Describe it instead' }], local.tab, 'data-ftab aria-label="How to give the arguments"') : '')
        + '<div class="' + K + 'form" data-fform' + (local.tab === 'form' ? '' : ' hidden') + '>' + formHtml(e.inputSchema, o.values) + '</div>'
        + (tool && o.canText ? '<div class="' + K + 'form" data-ftextpane' + (local.tab === 'text' ? '' : ' hidden') + '>' + UI.field('What should it do', UI.textarea('', { rows: 3, attrs: 'data-ftext', placeholder: 'For example: file an issue in FIN about the Q3 travel overrun review' }), 'The profile ' + esc(o.profile || 'selected in the composer') + ' turns this into arguments. You see them on a card and approve them before anything runs, whatever the tool does.') + '</div>' : '')
        + UI.notice(esc(how) + ' <span class="' + K + 'pkn">' + (tool ? 'It may receive data up to' : 'Labelled') + '</span> ' + UI.label(tool ? e.ceiling : e.label, { sm: true }), asks ? 'warn' : 'info') + '<div data-ferr></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(okLabel(), { kind: 'primary', attrs: 'data-fgo' }),
      onMount(el) {
        const go = el.querySelector('[data-fgo]'); const err = el.querySelector('[data-ferr]');
        const tabs = el.querySelector('[data-ftab]');
        if (tabs) tabs.addEventListener('click', (ev) => {
          const b = ev.target.closest('[data-seg]'); if (!b) return;
          local.tab = b.dataset.seg;
          tabs.querySelectorAll('[data-seg]').forEach((x) => { x.classList.toggle('active', x === b); x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
          el.querySelector('[data-fform]').hidden = local.tab !== 'form'; el.querySelector('[data-ftextpane]').hidden = local.tab !== 'text';
          go.textContent = okLabel(); err.innerHTML = '';
        });
        const first = el.querySelector(local.tab === 'text' ? '[data-ftext]' : '[data-fform] [data-arg]'); if (first) first.focus();
        go.addEventListener('click', async () => {
          let payload;
          if (local.tab === 'text') {
            const text = el.querySelector('[data-ftext]').value.trim();
            if (!text) { err.innerHTML = UI.notice('Say what the tool should do first.', 'warn'); return; }
            payload = { text };
          } else {
            const r = readForm(el.querySelector('[data-fform]'), e.inputSchema);
            if (r.errors) { err.innerHTML = UI.notice('<b>The form is not complete.</b> ' + r.errors.map(esc).join(' '), 'warn'); return; }
            payload = { arguments: r.args };
          }
          go.disabled = true; err.innerHTML = '';
          try { await o.submit(payload); } catch (x) {
            go.disabled = false;
            const p = (x && x.problem) || {};
            const list = Array.isArray(p.errors) ? p.errors.map((y) => (typeof y === 'string' ? y : [y.path || y.instancePath || y.field || '', y.message || ''].filter(Boolean).join(': '))).filter(Boolean) : [];
            err.innerHTML = UI.notice('<b>' + esc(x && x.status === 404 ? 'Not offered here.' : x && x.status === 400 ? 'The arguments do not match what the entry asks for.' : 'Refused.') + '</b> ' + esc(x && x.status === 404 ? 'It is not published for this conversation, is above its ceiling, or is not on the profile\'s list.' : p.detail || (x && x.message) || '') + (list.length ? ' ' + list.map(esc).join(' ') : ''), 'danger');
          }
        });
      }
    });
  }

  // ---------- what the buttons on a card do ----------
  /**
   * Registers the cards' handlers. o: { find(id), act(inv, action, arg) → Promise<inv>, fail(err, what) }. `act` calls
   * the server (or changes an example card); the confirmations and the words are the same either way.
   */
  function cardActions(ctx, o) {
    const run = async (inv, action, arg, done) => {
      try { const r = await o.act(inv, action, arg); done(r || inv); } catch (err) { o.fail(err, 'That could not be done'); }
    };
    const kvArgs = (inv) => [['Tool', '<span class="mono">' + esc(inv.name) + '</span>'], ['Side effect', sidePill(inv.sideEffect)]].concat(Object.keys(inv.arguments || {}).map((k) => { const x = inv.arguments[k]; return [k, '<span class="mono">' + esc(typeof x === 'string' ? x : JSON.stringify(x)) + '</span>']; }));
    const pathHtml = (h) => ((h.path || []).length ? '<div class="' + K + 'path">Path: ' + h.path.map((p) => esc(p.name)).join(' <span aria-hidden="true">›</span> ') + '</div>' : '');
    ctx.on('click', '[data-invok]', async (e, t) => {
      const inv = o.find(t.dataset.inv); if (!inv) return;
      if (inv.sideEffect === 'destructive') {
        const ok = await ctx.confirm({ title: 'Approve ' + inv.name + '?', tag: 'destructive', tone: 'danger', ok: 'Approve and run', body: '<div class="fg2">It runs as you with exactly these arguments and cannot be undone. When a guardrail rule says so, a reviewer decides in the flag queue before it runs. Your approval is written to the audit chain.</div>', kv: kvArgs(inv) });
        if (!ok) return;
      }
      run(inv, 'approve', null, (r) => ctx.toast(r.state === 'held' ? 'Approved by you. A reviewer now decides it in the flag queue; nothing has run yet.' : 'Approved. <span class="mono">' + esc(inv.name) + '</span> is running as you.', r.state === 'held' ? 'warn' : 'ok'));
    });
    ctx.on('click', '[data-invno]', (e, t) => { const inv = o.find(t.dataset.inv); if (inv) run(inv, 'deny', null, () => ctx.toast('Denied. Nothing ran, and the denial is recorded.')); });
    ctx.on('click', '[data-invcancel]', async (e, t) => {
      const inv = o.find(t.dataset.inv); if (!inv) return;
      if (inv.kind === 'tool') { run(inv, 'cancel', null, () => ctx.toast('Withdrawn. Nothing ran.')); return; }
      const ok = await ctx.confirm({ title: 'Cancel this ' + (inv.kind === 'workflow' ? 'workflow run' : 'run') + '?', tone: 'danger', ok: 'Cancel run', cancel: 'Keep running', body: '<div class="fg2">It stops at once. The steps so far and their checkpoints are kept in ' + (inv.kind === 'workflow' ? 'Workflows' : 'Runs') + '; nothing more joins this conversation from it.</div>', kv: [[inv.kind === 'workflow' ? 'Workflow' : 'Agent', esc(inv.name)], ['Steps so far', num(((inv.run || {}).steps || []).length)]] });
      if (ok) run(inv, 'cancel', null, () => ctx.toast('Run cancelled.', 'warn'));
    });
    ctx.on('click', '[data-heldok]', async (e, t) => {
      const inv = o.find(t.dataset.inv); const i = Number(t.dataset.heldok); const h = inv && (inv.held || [])[i]; if (!h) return;
      const wf = h.at && h.at.kind === 'workflow-run';
      const ok = await ctx.confirm({ title: 'Approve ' + (h.tool || (wf ? 'this step' : 'the call')) + '?', tag: h.sideEffect || '', tone: 'primary', ok: 'Approve', body: '<div class="fg2">' + (wf ? 'The workflow continues from this step.' : 'The call runs where it waits; every run above it continues when it returns.') + ' The decision is written to the audit chain with you as approver.</div>' + pathHtml(h), kv: [['Waits in', esc(wf ? 'workflow run, step ' + h.at.step : 'agent run, step ' + (h.at ? h.at.step : ''))], ['Approvers', esc(h.approvers || '')]] });
      if (ok) run(inv, 'held', { i, held: h, decision: 'approve' }, () => ctx.toast(wf ? 'Approved. The workflow continues.' : 'Approved from the conversation. The chain resumes where it waited.', 'ok'));
    });
    ctx.on('click', '[data-heldno]', (e, t) => {
      const inv = o.find(t.dataset.inv); const i = Number(t.dataset.heldno); const h = inv && (inv.held || [])[i]; if (!h) return;
      ctx.modal({ title: 'Reject ' + esc(h.tool || 'this step'), body: '<div class="fg2">Nothing is run. The agent or workflow where it waits is told who rejected it and why.</div>' + pathHtml(h) + UI.field('Reason (given to the agent and the owner)', UI.textarea('', { rows: 2, attrs: 'data-note' })),
        actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Reject', { kind: 'danger', attrs: 'data-ok' }),
        onMount(m) { m.querySelector('[data-ok]').addEventListener('click', () => { const note = m.querySelector('[data-note]').value.trim(); App.closeOverlay(); run(inv, 'held', { i, held: h, decision: 'reject', note }, () => ctx.toast('Rejected. Nothing ran for that call.', 'warn')); }); } });
    });
  }
  // ===== B-40 core end =====

  // ---------- the live screen ----------
  const enc = encodeURIComponent;
  const cUrl = (id) => '/api/conversations/' + enc(id);
  let d = null; // what chat.js lends: S, visible, rerender, schedule, loadConv, loadList, syncUrl, newLabel, richText, branchSwitch, handleError
  let picker = null; let ctxNow = null; let soon = null;

  const demoOf = (st) => st.capDemo || null;
  const capsOf = (st) => (demoOf(st) && demoOf(st).caps ? demoOf(st).caps : st.caps || null);
  const invOf = (st) => (st.inv && st.inv.for === st.convId ? st.inv : { list: [], skills: [] });
  const skillsOf = (st) => (demoOf(st) && demoOf(st).skills ? demoOf(st).skills : invOf(st).skills);
  const find = (st, id) => (demoOf(st) && demoOf(st).card && demoOf(st).card.id === id ? demoOf(st).card : invOf(st).list.filter((x) => x.id === id)[0] || null);
  const capsKey = (st) => (st.convId || 'new') + '|' + (st.profile || '');

  function loadCaps(force) {
    const st = d.S(); if (!App.can('chat:read') || !st.loaded) return;
    const k = capsKey(st); if (!force && st.capsKey === k) return;
    if (st.capsKey !== k) st.caps = null;
    st.capsKey = k; st.capsError = null;
    App.get(cUrl(st.convId || 'new') + '/capabilities' + (st.profile ? '?profile=' + enc(st.profile) : ''))
      .then((c) => { if (d.S() !== st || capsKey(st) !== k) return; st.caps = c; d.schedule(); })
      .catch((err) => { if (d.S() !== st || capsKey(st) !== k) return; st.caps = null; st.capsError = err; d.schedule(); });
  }
  function loadInv() {
    const st = d.S(); const id = st.convId;
    if (!id) { st.inv = null; return Promise.resolve(); }
    st.invFor = id;
    return App.get(cUrl(id) + '/invocations')
      .then((r) => { if (d.S() !== st || st.convId !== id) return; st.inv = { for: id, list: r.invocations || [], skills: r.skills || [] }; d.schedule(); })
      .catch(() => { if (d.S() === st && st.convId === id && !st.inv) st.inv = { for: id, list: [], skills: [] }; });
  }
  /** Reads the invocations and the conversation again shortly (several events of one change arrive together). */
  function refreshSoon(withConv) {
    soon = soon || { conv: false, timer: null };
    soon.conv = soon.conv || !!withConv;
    if (soon.timer) return;
    soon.timer = setTimeout(() => {
      const conv = soon.conv; soon = null;
      if (!d.visible()) return;
      Promise.all([loadInv(), conv ? d.loadConv(false) : null]).then(() => d.schedule());
    }, 150);
  }
  /** Called on every render: loads what the open conversation and the selected profile may call, and its invocations. */
  function sync(st) {
    if (!st.loaded) return;
    loadCaps(false);
    if (st.convId && st.invFor !== st.convId) loadInv();
    if (!st.convId) { st.inv = null; st.invFor = null; }
  }
  function put(st, inv) {
    if (!inv || !inv.id || !st.convId) return;
    if (!st.inv || st.inv.for !== st.convId) st.inv = { for: st.convId, list: [], skills: [] };
    const i = st.inv.list.findIndex((x) => x.id === inv.id);
    if (i >= 0) st.inv.list[i] = inv; else st.inv.list.push(inv);
  }
  /** The conversation the first invocation or skill needs: created now, with the label the composer shows. */
  async function ensureConv() {
    const st = d.S(); if (st.convId) return st.convId;
    const c = await App.post('/api/conversations', { label: d.newLabel() });
    const kbIds = st.newKbs || [];
    if (kbIds.length && App.can('context:write')) { try { await App.api('PUT', cUrl(c.id) + '/knowledge', { kbIds }); st.bound = kbIds; } catch (err) { st.bound = []; } } else st.bound = [];
    st.newKbs = []; st.convId = c.id; d.syncUrl(c.id);
    await Promise.all([d.loadConv(false), d.loadList()]);
    return c.id;
  }
  async function afterCall(st, inv) {
    put(st, inv);
    await Promise.all([loadInv(), d.loadConv(false)]);
    loadCaps(false);
    d.rerender(true);
  }
  const argLine = (a) => Object.keys(a || {}).map((k) => k + '=' + (typeof a[k] === 'string' ? a[k] : JSON.stringify(a[k]))).join(' ');

  async function callTool(e, payload) {
    const st = d.S();
    if (demoOf(st)) { const inv = exampleCall(e, payload); st.capDemo.card = inv; App.closeOverlay(); d.rerender(true); if (inv.state === 'running') exampleAct(inv, 'run', null, d.schedule); return; }
    const id = await ensureConv();
    const body = Object.assign({ tool: e.name }, payload.text ? { text: payload.text } : { arguments: payload.arguments }, st.profile ? { profile: st.profile } : {});
    const r = await App.post(cUrl(id) + '/tools', body);
    App.closeOverlay();
    if (r.state === 'pending') App.toast(payload.text ? 'The profile turned your words into arguments. Check the card; nothing has run.' : 'Nothing has run. Approve or deny the card in the conversation.');
    else if (r.state === 'blocked') App.toast('<b>Blocked by the tool-call guardrail.</b> Nothing ran.', 'danger', 6000);
    else if (r.state === 'held') App.toast('Held for review. A reviewer decides it in the flag queue; nothing has run.', 'warn', 6000);
    else App.toast('<span class="mono">' + esc(e.name) + '</span> is running as you. Its result joins the conversation.');
    await afterCall(st, r);
  }
  async function startWorkflow(e, payload) {
    const st = d.S();
    if (demoOf(st)) { const inv = exampleWorkflow(e, payload); st.capDemo.card = inv; App.closeOverlay(); d.rerender(true); exampleAct(inv, 'play', null, d.schedule); return; }
    const id = await ensureConv();
    const r = await App.post(cUrl(id) + '/workflows', Object.assign({ workflow: e.name, input: payload.arguments || {} }, st.profile ? { profile: st.profile } : {}));
    App.closeOverlay();
    App.toast('Workflow started. Its steps and approvals appear on the card.', 'ok');
    await afterCall(st, r);
  }
  async function startAgent(a, input, turns) {
    const st = d.S();
    if (demoOf(st)) { const inv = exampleAgent(a, input); st.capDemo.card = inv; st.draft = ''; st.capTarget = null; d.rerender(true); exampleAct(inv, 'play', null, d.schedule); return; }
    const id = await ensureConv();
    const r = await App.post(cUrl(id) + '/agents', Object.assign({ agent: a.name, input }, turns ? { context: turns } : {}, st.profile ? { profile: st.profile } : {}));
    App.toast('Run started with ' + esc(a.name) + (turns ? ', which may read the last ' + turns + ' turns within its ceiling.' : '. It reads only this message.'), 'ok');
    st.draft = ''; st.capTarget = null;
    await afterCall(st, r);
  }
  async function setSkill(name, mode) {
    const st = d.S();
    if (demoOf(st)) {
      const e = (capsOf(st).skills || []).filter((x) => x.name === name)[0];
      st.capDemo.skills = (skillsOf(st) || []).filter((x) => x.name !== name).concat(mode ? [{ name, version: e ? e.version : '', mode, available: true, reason: null }] : []);
      (capsOf(st).skills || []).forEach((x) => { if (x.name === name) x.active = mode; });
      d.rerender(true); return;
    }
    const id = mode ? await ensureConv() : st.convId; if (!id) return;
    const r = mode ? await App.api('PUT', cUrl(id) + '/skills/' + enc(name), Object.assign({ mode }, st.profile ? { profile: st.profile } : {})) : await App.api('DELETE', cUrl(id) + '/skills/' + enc(name));
    if (!st.inv || st.inv.for !== id) st.inv = { for: id, list: [], skills: [] };
    st.inv.skills = (r && r.skills) || []; st.invFor = id;
    loadCaps(true);
    d.rerender(true);
  }

  /** What a card's button does: an example card changes on the page only; a real one asks the server. */
  async function act(inv, action, arg) {
    const st = d.S();
    if (inv.example) { exampleAct(inv, action, arg, d.schedule); return inv; }
    const base = cUrl(st.convId) + '/invocations/' + enc(inv.id);
    let r;
    if (action === 'approve' || action === 'deny') r = await App.post(base + '/decision', { decision: action });
    else if (action === 'cancel') r = await App.post(base + '/cancel', {});
    else { const h = arg.held; r = await App.post(base + '/held', Object.assign({ node: h.node, decision: arg.decision }, arg.note ? { note: arg.note } : {}, h.at && h.at.kind === 'agent-run' ? { step: h.at.step } : h.at && h.at.approval ? { approval: h.at.approval } : {})); }
    put(st, r); d.schedule(); refreshSoon(true);
    return r;
  }
  function fail(err, what) {
    const p = (err && err.problem) || {};
    if (err && err.status === 409) { App.toast('<b>No longer waiting.</b> ' + esc(p.detail || 'It was decided or it expired in the meantime.'), 'warn', 6000); refreshSoon(true); return; }
    if (err && err.status === 403) { App.toast('<b>Not yours to decide.</b> ' + esc(p.detail || err.message), 'warn', 6000); refreshSoon(false); return; }
    d.handleError(err, what);
  }

  function pick(r, mode) {
    const st = d.S(); const ta = document.getElementById('ch-composer');
    st.draft = ''; if (ta) ta.value = ''; picker.paint();
    if (r.kind === 'tool' || r.kind === 'workflow') {
      openForm(ctxNow, { kind: r.kind, entry: r.e, profile: st.profile, canText: r.kind === 'tool' && App.can('inference:invoke') && !!st.profile, submit: (p) => (r.kind === 'tool' ? callTool(r.e, p) : startWorkflow(r.e, p)) });
      return;
    }
    if (r.kind === 'agent') { st.capTarget = { name: r.e.name, version: r.e.version, context: 0 }; d.rerender(true); App.toast('The next message goes to ' + esc(r.e.name) + '. Its run appears as a card in this conversation.'); return; }
    setSkill(r.e.name, mode).then(() => App.toast(esc(r.e.name) + (mode === 'once' ? ' added for the next turn only.' : ' added. Its instructions join every turn until you remove it.'), 'ok'), (err) => fail(err, 'Could not add the skill'));
  }

  // ---------- what chat.js asks for ----------
  /** The assistant-role message of an invocation, as its card (and, for an agent, its answer). */
  function messageHtml(st, conv, m) {
    const inv = find(st, m.invocationId);
    const answer = inv && inv.kind === 'agent' && m.state === 'complete' && m.content ? m.content : null;
    return '<div class="ch-msg ch-ai" data-mid="' + esc(m.id) + '">'
      + (inv ? cardHtml(inv, { answer, rich: (t) => d.richText(t, m), canAct: App.can('chat:write'), flags: App.can('flags:review') }) : '<div class="ch-status">Loading…</div>')
      + '<div class="ch-mactions">' + (answer ? UI.iconbtn('copy', 'Copy answer', { cls: 'sm', attrs: 'data-cp="' + esc(m.id) + '"' }) : '') + d.branchSwitch(conv, m) + '</div></div>';
  }
  /** A design state's example card, after the conversation's own messages. */
  function exampleHtml(st) {
    const c = demoOf(st) && demoOf(st).card; if (!c) return '';
    return '<div class="ch-msg ch-user"><div class="ch-bubble">' + esc(c.say || c.name) + '</div></div><div class="ch-msg ch-ai">' + cardHtml(c, { rich: (t) => d.richText(t, null), canAct: true, flags: App.can('flags:review') }) + '</div>';
  }
  function barHtml(st) {
    return capsBarHtml({ skills: skillsOf(st), target: st.capTarget, canEdit: App.can('chat:write') });
  }
  /** Repaints a region and keeps the keyboard where it was: on the same control, or on the card when that control is gone. */
  function keepFocus(main, region, fn) {
    const host = main.querySelector('[data-region="' + region + '"]'); const a = document.activeElement;
    const inside = !!(host && a && a !== host && host.contains(a));
    const fk = inside ? a.getAttribute('data-fk') : null; const card = inside && a.closest('[data-invcard]') ? a.closest('[data-invcard]').getAttribute('data-invcard') : null;
    fn();
    if (!inside || document.contains(a)) return;
    const again = fk ? Array.prototype.filter.call(host.querySelectorAll('[data-fk]'), (x) => x.getAttribute('data-fk') === fk)[0] : null;
    const to = again || (card ? Array.prototype.filter.call(host.querySelectorAll('[data-invcard]'), (x) => x.getAttribute('data-invcard') === card)[0] : null);
    if (to) { if (!again) to.setAttribute('tabindex', '-1'); to.focus({ preventScroll: true }); }
  }
  /** Registers the handlers of one render (ctx.on drops them on the next) and draws the picker. */
  function mount(ctx) {
    const st = ctx.state; ctxNow = ctx;
    st.pk = st.pk || { active: 0, mode: 'sticky', dismissed: false };
    picker = pickerControl({
      composer: () => document.getElementById('ch-composer'), host: () => ctx.$('[data-region="picker"]'), caps: () => capsOf(d.S()), state: () => d.S().pk, pick,
      pending: () => { const e = d.S().capsError; return '<div class="ch-pk" id="ch-pk"><div class="ch-pke" role="status">' + (e ? '<b>What this conversation may call could not be loaded</b>' + esc((e.problem && e.problem.detail) || e.message || '') : 'Loading…') + '</div></div>'; }
    });
    picker.paint();
    ctx.on('click', '[data-new], [data-convo], [data-sharedconv]', () => { st.capDemo = null; st.capTarget = null; });
    ctx.on('input', '#ch-composer', () => picker.input());
    ctx.on('keydown', '[data-pk]', (e) => { picker.key(e); });
    ctx.on('mousedown', '[data-pk]', (e) => { e.preventDefault(); });
    ctx.on('click', '[data-pk]', (e) => picker.click(e));
    ctx.on('click', '[data-trigger]', (e, t) => { st.draft = t.dataset.trigger; picker.open(t.dataset.trigger); });
    ctx.on('click', '[data-rmskill]', (e, t) => { const name = t.dataset.rmskill; t.disabled = true; setSkill(name, null).then(() => App.toast(esc(name) + ' removed. Its instructions are left out from the next turn on.'), (err) => { t.disabled = false; fail(err, 'Could not remove the skill'); }); });
    ctx.on('click', '[data-tooff]', () => { st.capTarget = null; d.rerender(true); App.toast('The next message goes to the model again.'); });
    ctx.on('change', '[data-tocontext]', (e, t) => { if (st.capTarget) st.capTarget.context = Number(t.value); });
    cardActions(ctx, { find: (id) => find(d.S(), id), act, fail });
  }
  /** The composer's keys while the picker is open. True when the key was the picker's. */
  function key(e) { return picker ? picker.key(e) : false; }
  /** After a region repaint (streaming, a loaded list): the picker follows what may be called now. */
  function painted() { if (picker && d.visible() && !document.getElementById('overlay')) picker.paint(); }
  /**
   * Send, when the message is for an agent: one picked with "@" (shown above the composer), or named in full at the
   * start ("@Data analyst how far over is travel?"). True when it took the message.
   */
  function trySend(text) {
    const st = d.S(); const caps = capsOf(st);
    const named = st.capTarget ? null : agentPrefix(caps, text);
    if (!st.capTarget && !named) return false;
    const a = st.capTarget ? ((caps && caps.agents) || []).filter((x) => x.name === st.capTarget.name)[0] || st.capTarget : named.agent;
    const input = st.capTarget ? text : named.input;
    if (!input) { App.toast('Say what ' + esc(a.name) + ' should do.'); return true; }
    if (st.sending) return true;
    const turns = st.capTarget ? st.capTarget.context : 0;
    st.sending = true; d.schedule();
    startAgent(a, input, turns).then(() => { st.sending = false; d.schedule(); }, (err) => { st.sending = false; d.schedule(); fail(err, 'Could not start the run'); });
    return true;
  }

  // ---------- socket ----------
  const mine = (st, runId) => invOf(st).list.filter((x) => x.run && x.run.id === runId)[0] || null;
  const handlers = {
    'chat.invocation'(st, e) { if (e.conversationId === st.convId) refreshSoon(true); },
    'chat.skills'(st, e) { if (e.conversationId === st.convId) { refreshSoon(false); loadCaps(true); } },
    'run.step'(st, e) {
      const inv = mine(st, e.runId); if (!inv) return;
      const steps = inv.run.steps = inv.run.steps || []; const s = { n: e.n, lane: e.lane, title: e.title, state: e.state };
      const i = steps.findIndex((x) => x.n === e.n); if (i >= 0) steps[i] = s; else steps.push(s);
      steps.sort((x, y) => x.n - y.n);
      if (inv.run.usage) inv.run.usage.steps = Math.max(inv.run.usage.steps || 0, steps.length);
      d.schedule();
    },
    'run.state'(st, e) { const inv = mine(st, e.runId); if (!inv) return; inv.run.state = e.state; d.schedule(); refreshSoon(e.state !== 'running' && e.state !== 'queued'); },
    'workflow.run'(st, e) { if (mine(st, e.runId)) refreshSoon(true); },
    'workflow.step'(st, e) { if (mine(st, e.runId)) refreshSoon(false); },
    'workflow.approval'(st, e) { if (mine(st, e.runId)) refreshSoon(false); }
  };

  // ---------- design states (the board's states; applied by App.applyState, as the accessibility suite does) ----------
  function show(o) {
    return (ctx) => {
      const st = ctx.state; const caps = EXCAPS();
      caps.conversation.profile = st.profile || caps.conversation.profile;
      if (o.notOffered) { caps.tools = []; caps.workflows = []; caps.restricted.tools = true; caps.restricted.workflows = true; }
      (o.skills || []).forEach((k) => caps.skills.forEach((x) => { if (x.name === k.name) x.active = k.mode; }));
      st.capDemo = { caps, card: o.card ? example(o.card) : null, skills: o.skills || [] };
      st.capTarget = null; st.draft = o.draft || ''; st.pk = { active: 0, mode: 'sticky', dismissed: false };
      d.rerender(o.draft !== undefined);
      if (o.play) exampleAct(st.capDemo.card, 'play', null, d.schedule);
      if (o.form) { const e = caps.tools[1]; openForm(ctx, { kind: 'tool', entry: e, profile: st.profile || 'general', canText: true, submit: (p) => callTool(e, p) }); }
    };
  }
  const states = [
    { title: 'Slash picker open', tone: 'neutral', text: 'Typing / at the start of the composer lists the tools and workflows this conversation may call, with each tool\'s side-effect class and ceiling. Arrow keys move, Enter picks, Esc closes.', apply: show({ draft: '/' }) },
    { title: 'Agent picker open', tone: 'neutral', text: 'Typing @ lists the published agents within the conversation\'s label. The next message goes to the one picked.', apply: show({ draft: '@' }) },
    { title: 'Skill picker open', tone: 'neutral', text: 'Typing + lists the published skills. A skill applies until it is removed, or for the next turn only.', apply: show({ draft: '+' }) },
    { title: 'Entry not offered', tone: 'neutral', text: 'The profile\'s list or the conversation\'s ceiling leaves nothing to call. The picker says why instead of listing entries; calling one by name is refused the same way.', apply: show({ draft: '/', notOffered: true }) },
    { title: 'Tool form', tone: 'neutral', text: 'A form built from the tool\'s input schema: text, numbers, yes or no, choices, required marks and the descriptions as hints. "Describe it instead" lets the profile turn words into arguments.', apply: show({ form: true }) },
    { title: 'Arguments from text', tone: 'info', text: 'The profile turned the caller\'s words into arguments. They are shown on an approval card before anything runs, whatever the tool does.', apply: show({ card: 'fromText' }) },
    { title: 'Tool running', tone: 'info', text: 'A read tool runs at once as the caller. The card shows the exact arguments while it runs.', apply: show({ card: 'toolRunning' }) },
    { title: 'Tool result', tone: 'ok', text: 'The call and its result join the conversation as a tool turn. The model sees both on the next turn.', apply: show({ card: 'toolDone' }) },
    { title: 'Tool failed', tone: 'danger', text: 'The tool ran and failed. The card says why; nothing is retried on its own.', apply: show({ card: 'toolFailed' }) },
    { title: 'Approval card pending', tone: 'warn', text: 'A write tool waits for the caller\'s own approval: the tool, its side-effect class, the exact arguments, Approve and Deny. Nothing has run.', apply: show({ card: 'pending' }) },
    { title: 'Destructive approval', tone: 'danger', text: 'A destructive call says it cannot be undone and that a reviewer also decides when a rule says so. Approving asks once more with the exact arguments.', apply: show({ card: 'destructive' }) },
    { title: 'Held for review', tone: 'warn', text: 'The tool-call guardrail holds the call. A reviewer other than the caller decides it in the flag queue; the card names the flag.', apply: show({ card: 'held' }) },
    { title: 'Card denied', tone: 'neutral', text: 'The caller denied the card. Nothing ran, and the denial is recorded.', apply: show({ card: 'denied' }) },
    { title: 'Card expired', tone: 'neutral', text: 'Nobody decided before the card expired. Nothing ran.', apply: show({ card: 'expired' }) },
    { title: 'Rejected by the reviewer', tone: 'danger', text: 'The reviewer rejected the held call in the flag queue. Nothing ran.', apply: show({ card: 'rejected' }) },
    { title: 'Blocked by the guardrail', tone: 'danger', text: 'A tool-call rule blocks the call outright. It is recorded as blocked and nothing ran.', apply: show({ card: 'blocked' }) },
    { title: 'Agent run streaming', tone: 'info', text: 'An agent run started with @ shows as a run card: steps arrive with their lane, budgets fill, and the run can be cancelled or opened in Runs.', apply: show({ card: 'agentRunning', play: true }) },
    { title: 'Agent run waiting on a held call', tone: 'info', text: 'A write call held in a delegate pauses the whole chain. The card shows the path from the root and decides it from the conversation.', apply: show({ card: 'agentWaiting' }) },
    { title: 'Agent run stopped at its budget', tone: 'warn', text: 'The run reached a limit. Its checkpoint is kept; the limit is raised in Runs, or the run is cancelled here.', apply: show({ card: 'agentBudget' }) },
    { title: 'Agent answer', tone: 'ok', text: 'The run\'s answer becomes a turn of the conversation, attributed to the agent and its version.', apply: show({ card: 'agentDone' }) },
    { title: 'Workflow run paused on an approval', tone: 'info', text: 'A workflow started with /workflow shows its steps on a card. Its approval is decided there, and approving resumes the chain.', apply: show({ card: 'workflowWaiting' }) },
    { title: 'Skill chips', tone: 'neutral', text: 'Each active skill shows above the composer with how long it applies: sticky, or next turn only. Removing one leaves its instructions out of the very next turn.', apply: show({ skills: [{ name: 'house-style', version: '1.0.0', mode: 'sticky', available: true, reason: null }, { name: 'finance-glossary', version: '2.0.0', mode: 'once', available: true, reason: null }] }) }
  ];

  App.chatCaps = {
    css: CSS, states, handlers,
    init(deps) { d = deps; },
    sync, mount, key, painted, trySend, messageHtml, exampleHtml, barHtml, keepFocus
  };
})();
