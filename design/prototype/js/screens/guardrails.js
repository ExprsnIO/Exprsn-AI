(function () {
  const { UI, esc } = App;

  const PROFILES = [
    { id: 'finance-v12', name: 'Finance baseline', version: 12, status: 'published', scope: 'Workspace Finance Ops', owner: 'Mara Okafor' },
    { id: 'finance-v13', name: 'Finance baseline', version: 13, status: 'draft', scope: 'Workspace Finance Ops', owner: 'Mara Okafor' },
    { id: 'platform-v4', name: 'Platform baseline', version: 4, status: 'published', scope: 'Platform, all tenants', owner: 'Platform guardrail admins', locked: true }
  ];
  const CHECKPOINTS = [
    { id: 'user-input', label: 'User input' }, { id: 'context', label: 'Context' }, { id: 'tool-call', label: 'Proposed tool call' }, { id: 'model-output', label: 'Model output' }, { id: 'image', label: 'Image' },
    { id: 'context-transfer', label: 'Context transfer' }, { id: 'memory', label: 'Memory write and read' }, { id: 'script', label: 'Script generation' }, { id: 'db-query', label: 'Database query' }, { id: 'media', label: 'Media' }, { id: 'export', label: 'Export and delivery' }
  ];
  // Rule: id, name, type, action, stage, triggers, fp, latency, onError, checkpoint, mechanism, threshold/pattern, baseline (platform-owned)
  const RULES = [
    { id: 'secrets-input', name: 'Secrets and private keys', cp: 'user-input', type: 'pattern', action: 'block', stage: 'enforce', triggers: '0.05%', fp: '0.0%', latency: '0.3 ms', onError: 'n/a', mechanism: 're2 pattern', pattern: '(?i)(-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{32,})', baseline: true },
    { id: 'pii-input', name: 'PII in prompts', cp: 'user-input', type: 'PII', action: 'redact', stage: 'enforce', triggers: '0.9%', fp: '2.0%', latency: '0.6 ms', onError: 'n/a', mechanism: 'detector pii.*', threshold: '0.80' },
    { id: 'injection-input', name: 'Prompt injection phrases', cp: 'user-input', type: 'prompt injection', action: 'log', stage: 'enforce', triggers: '0.3%', fp: '11.0%', latency: '6 ms', onError: 'allow', mechanism: 'classifier', threshold: '0.70' },
    { id: 'budget-input', name: 'Turn token budget', cp: 'user-input', type: 'budget', action: 'block', stage: 'enforce', triggers: '0.01%', fp: '0.0%', latency: '0.1 ms', onError: 'n/a', mechanism: 'redis counter', threshold: '32768 tokens' },
    { id: 'injection-ctx', name: 'Injection in retrieved text', cp: 'context', type: 'prompt injection', action: 'block', stage: 'enforce', triggers: '0.12%', fp: '4.4%', latency: '7 ms', onError: 'closed', mechanism: 'classifier', threshold: '0.75', baseline: true },
    { id: 'delimit-ctx', name: 'Delimit and label context', cp: 'context', type: 'pattern', action: 'allow', stage: 'enforce', triggers: '100%', fp: '0.0%', latency: '0.1 ms', onError: 'n/a', mechanism: 'wrapper', pattern: '<context label=… tier=context>', baseline: true },
    { id: 'clearance-ctx', name: 'Chunk above clearance', cp: 'context', type: 'pattern', action: 'block', stage: 'enforce', triggers: '0.0%', fp: '0.0%', latency: '0.1 ms', onError: 'closed', mechanism: 'label check', threshold: 'user clearance', baseline: true },
    { id: 'tool-after-ctx', name: 'Tool call right after context', cp: 'tool-call', type: 'prompt injection', action: 'require-approval', stage: 'enforce', triggers: '3.1%', fp: '0.0%', latency: '0.2 ms', onError: 'closed', mechanism: 'rule', threshold: 'next turn', baseline: true },
    { id: 'tool-egress', name: 'Tool label ceiling', cp: 'tool-call', type: 'pattern', action: 'block', stage: 'enforce', triggers: '0.4%', fp: '0.0%', latency: '0.1 ms', onError: 'closed', mechanism: 'label check', threshold: 'tool ceiling', baseline: true },
    { id: 'tool-write', name: 'Write side effects', cp: 'tool-call', type: 'pattern', action: 'require-approval', stage: 'enforce', triggers: '1.8%', fp: '0.0%', latency: '0.1 ms', onError: 'n/a', mechanism: 'side-effect class', threshold: 'write, destructive' },
    { id: 'tool-steps', name: 'Agent step budget', cp: 'tool-call', type: 'budget', action: 'block', stage: 'enforce', triggers: '0.2%', fp: '0.0%', latency: '0.1 ms', onError: 'n/a', mechanism: 'redis counter', threshold: '24 steps' },
    { id: 'tool-external', name: 'External domains', cp: 'tool-call', type: 'topic', action: 'warn', stage: 'shadow', triggers: '0.6%', fp: '8.0%', latency: '2 ms', onError: 'allow', mechanism: 'allow-list', threshold: 'internal domains' },
    { id: 'secrets-out', name: 'Secrets and private keys', cp: 'model-output', type: 'pattern', action: 'block', stage: 'enforce', triggers: '0.02%', fp: '0.0%', latency: '0.3 ms', onError: 'n/a', mechanism: 're2 pattern', pattern: '(?i)(-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{32,})', baseline: true },
    { id: 'pii-iban', name: 'PII-IBAN', cp: 'model-output', type: 'PII', action: 'redact', stage: 'enforce', triggers: '0.41%', fp: '1.2%', latency: '0.5 ms', onError: 'n/a', mechanism: 'detector pii.iban', threshold: '0.90' },
    { id: 'numeric-grounding', name: 'Numeric grounding', cp: 'model-output', type: 'grounding', action: 'flag', stage: 'enforce', triggers: '2.9%', fp: '6.0%', latency: '4 ms', onError: 'allow', mechanism: 'calc and citation overlap', threshold: '0.95 overlap' },
    { id: 'safety', name: 'Safety categories', cp: 'model-output', type: 'guard model', action: 'block', stage: 'enforce', triggers: '0.08%', fp: '3.1%', latency: '210 ms', onError: 'closed', mechanism: 'llama-guard3:8b', threshold: 'S1 to S13', baseline: true },
    { id: 'no-legal-advice', name: 'No legal advice', cp: 'model-output', type: 'topic', action: 'warn', stage: 'shadow', triggers: '1.7%', fp: '22.0%', latency: '9 ms', onError: 'allow', mechanism: 'embedding similarity', threshold: '0.78' },
    { id: 'cite-kb', name: 'Answers cite the knowledge base', cp: 'model-output', type: 'grounding', action: 'warn', stage: 'enforce', triggers: '4.2%', fp: '5.5%', latency: '3 ms', onError: 'allow', mechanism: 'citation presence', threshold: '1 citation' },
    { id: 'img-prompt', name: 'Image prompt safety', cp: 'image', type: 'guard model', action: 'block', stage: 'enforce', triggers: '0.3%', fp: '2.2%', latency: '190 ms', onError: 'closed', mechanism: 'llama-guard3:8b', threshold: 'S1 to S13', baseline: true },
    { id: 'img-output', name: 'Image output classifier', cp: 'image', type: 'safety', action: 'block', stage: 'enforce', triggers: '0.1%', fp: '1.0%', latency: '340 ms', onError: 'closed', mechanism: 'image-safety classifier', threshold: '0.85', baseline: true },
    { id: 'xfer-customer', name: 'Customer IDs on transfer', cp: 'context-transfer', type: 'PII', action: 'flag', stage: 'enforce', triggers: '0.7%', fp: '3.0%', latency: '1 ms', onError: 'allow', mechanism: 'detector pii.customer-id', threshold: '0.80' },
    { id: 'xfer-label', name: 'Label ceiling across workspaces', cp: 'context-transfer', type: 'pattern', action: 'block', stage: 'enforce', triggers: '0.1%', fp: '0.0%', latency: '0.1 ms', onError: 'closed', mechanism: 'label check', threshold: 'target ceiling', baseline: true },
    { id: 'mem-pii', name: 'PII in proposed memory', cp: 'memory', type: 'PII', action: 'require-approval', stage: 'enforce', triggers: '2.1%', fp: '4.0%', latency: '0.6 ms', onError: 'n/a', mechanism: 'detector pii.*', threshold: '0.80' },
    { id: 'mem-secrets', name: 'Secrets in memory', cp: 'memory', type: 'pattern', action: 'block', stage: 'enforce', triggers: '0.0%', fp: '0.0%', latency: '0.2 ms', onError: 'n/a', mechanism: 're2 pattern', pattern: 'sk-[A-Za-z0-9]{32,}', baseline: true },
    { id: 'mem-inject', name: 'Injection on memory read', cp: 'memory', type: 'prompt injection', action: 'log', stage: 'shadow', triggers: '0.05%', fp: '9.0%', latency: '6 ms', onError: 'allow', mechanism: 'classifier', threshold: '0.70' },
    { id: 'script-net', name: 'Network calls in scripts', cp: 'script', type: 'pattern', action: 'require-approval', stage: 'enforce', triggers: '12.0%', fp: '0.5%', latency: '1 ms', onError: 'n/a', mechanism: 're2 pattern', pattern: '\\b(requests|urllib|fetch|socket)\\b' },
    { id: 'script-secrets', name: 'Hard-coded credentials', cp: 'script', type: 'pattern', action: 'block', stage: 'enforce', triggers: '0.4%', fp: '1.1%', latency: '0.4 ms', onError: 'n/a', mechanism: 're2 pattern', pattern: '(?i)(password|api[_-]?key)\\s*=\\s*[\'"][^\'"]{8,}' },
    { id: 'db-write', name: 'Writes and DDL', cp: 'db-query', type: 'pattern', action: 'block', stage: 'enforce', triggers: '0.9%', fp: '0.0%', latency: '2 ms', onError: 'closed', mechanism: 'node-sql-parser', threshold: 'side-effect class', baseline: true },
    { id: 'db-pii', name: 'PII columns in results', cp: 'db-query', type: 'PII', action: 'redact', stage: 'enforce', triggers: '18.0%', fp: '0.0%', latency: '0.8 ms', onError: 'n/a', mechanism: 'column classification', threshold: 'masked' },
    { id: 'media-safety', name: 'Frame safety', cp: 'media', type: 'guard model', action: 'block', stage: 'enforce', triggers: '0.02%', fp: '2.5%', latency: '410 ms', onError: 'closed', mechanism: 'image-safety classifier', threshold: '0.85', baseline: true },
    { id: 'media-pii', name: 'PII in transcripts and OCR', cp: 'media', type: 'PII', action: 'redact', stage: 'enforce', triggers: '3.3%', fp: '2.0%', latency: '1 ms', onError: 'n/a', mechanism: 'detector pii.*', threshold: '0.80' },
    { id: 'export-label', name: 'Label on export', cp: 'export', type: 'pattern', action: 'allow', stage: 'enforce', triggers: '100%', fp: '0.0%', latency: '0.1 ms', onError: 'n/a', mechanism: 'watermark and metadata', threshold: 'always', baseline: true },
    { id: 'export-iban', name: 'PII-IBAN', cp: 'export', type: 'PII', action: 'flag', stage: 'enforce', triggers: '0.6%', fp: '1.5%', latency: '0.5 ms', onError: 'n/a', mechanism: 'detector pii.iban', threshold: '0.90' },
    { id: 'export-restricted', name: 'Restricted leaves the tenant', cp: 'export', type: 'pattern', action: 'block', stage: 'enforce', triggers: '0.0%', fp: '0.0%', latency: '0.1 ms', onError: 'closed', mechanism: 'label check', threshold: 'restricted', baseline: true }
  ];
  const TESTS = {
    'no-legal-advice': { before: 'You should ', span: 'terminate the contract under clause 9', after: ' and claim damages.', score: 0.84, unit: 'similarity' },
    'numeric-grounding': { before: 'Travel spend for Q3 came to 412,880 EUR against a budget of 361,500 EUR. ', span: 'The Lisbon programme alone ran 71% over its allocation', after: ', which the approved exception only partly covers.', score: 0.0, unit: 'overlap' },
    'pii-iban': { before: 'Pay the supplier at ', span: 'DE89 3704 0044 0532 0130 00', after: ' by Friday.', score: 0.99, unit: 'confidence' },
    'secrets-out': { before: 'Use the key ', span: 'sk-9f3ab21c7d4e5f6a8b9c0d1e2f3a4b5c6d7e', after: ' for the staging gateway.', score: 1, unit: 'match' },
    'safety': { before: 'The safest way to ', span: 'settle this is to talk to the supplier first', after: '.', score: 0.02, unit: 'S6 score' },
    'cite-kb': { before: 'The policy allows taxis after 22:00 ', span: 'without pre-approval', after: '.', score: 0, unit: 'citations' },
    default: { before: 'Sample text: ', span: 'the Lisbon programme ran 71% over', after: '.', score: 0.31, unit: 'score' }
  };
  const yamlFor = (r, thr, action) => 'id: ' + r.id + '\ncheckpoint: ' + r.cp + '\ntype: ' + r.type.replace(' ', '-') + '\nmechanism: ' + r.mechanism.split(' ')[0] + (r.pattern != null ? '\npattern: \'' + r.pattern + '\'' : '\nthreshold: ' + thr) + '\naction: ' + action + '\nonError: ' + (r.onError === 'n/a' ? 'n/a' : r.onError) + (r.baseline ? '\nowner: platform-baseline' : '');
  const fpFor = (thr) => Math.max(0, Math.round((22 - (thr - 0.78) * 200) * 10) / 10);
  const wouldFor = (thr) => Math.max(0, Math.round(311 - (thr - 0.78) * 2000));

  App.register({
    id: 'guardrails', title: 'Guardrails', summary: 'Profiles, rules, form and YAML editor, live test, shadow replay, approvals', section: 'admin',
    crumb: (st) => { const p = PROFILES.find((x) => x.id === st.profile) || PROFILES[0]; return ['Admin', 'Guardrails', p.name + ' v' + p.version]; },
    commands: [
      { label: 'Test a guardrail rule', sub: 'Guardrails', run(app) { const s = app.stateFor('guardrails'); s.focusTest = true; app.render(); } },
      { label: 'Promote a rule to enforce', sub: 'Guardrails', run(app) { const s = app.stateFor('guardrails'); s.cp = 'model-output'; s.rule = 'no-legal-advice'; app.render(); setTimeout(() => { const b = document.querySelector('#main [data-promote]'); if (b) b.click(); }, 80); } }
    ],
    states: [
      { title: 'Invalid pattern', tone: 'danger', text: 'RE2 rejects backreferences. The editor shows the position and an equivalent pattern where one exists.', apply(ctx) { const st = ctx.state; st.profile = 'finance-v13'; st.cp = 'script'; st.rule = 'script-secrets'; st.view = 'form'; st.edits = st.edits || {}; st.edits['script-secrets'] = { pattern: '(?i)(password|api[_-]?key)\\s*=\\s*([\'"]).{8,}\\2' }; st.patternError = { pos: 41, msg: 'invalid escape sequence: \\2 (backreferences are not supported by RE2)', fix: '(?i)(password|api[_-]?key)\\s*=\\s*[\'"][^\'"]{8,}[\'"]' }; ctx.rerender(); } },
      { title: 'Baseline locked', tone: 'warn', text: 'A tenant admin cannot relax a platform baseline rule. It shows locked, with the owner and a request-change link.', apply(ctx) { const st = ctx.state; st.profile = 'finance-v12'; st.cp = 'model-output'; st.rule = 'safety'; st.view = 'form'; st.lockTried = true; ctx.rerender(); } },
      { title: 'Second approver', tone: 'info', text: 'Changes to the platform baseline wait for a second guardrail admin.', apply(ctx) { const st = ctx.state; st.profile = 'platform-v4'; st.cp = 'model-output'; st.rule = 'secrets-out'; st.pendingApproval = { rule: 'secrets-out', by: 'Mara Okafor', at: '19 Sep 14:20', change: 'threshold entropy 3.8 to 4.2' }; ctx.rerender(); } },
      { title: 'Fail closed', tone: 'danger', text: 'While the guard model is down, confidential and tool-calling turns are held. Each fail-open decision elsewhere is flagged.', apply(ctx) { const st = ctx.state; st.guardDown = true; st.cp = 'model-output'; st.rule = 'safety'; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      if (ctx.params.rule) { const r0 = RULES.find((r) => r.id === ctx.params.rule); if (r0) { st.rule = r0.id; st.cp = r0.cp; } delete ctx.params.rule; }
      st.profile = st.profile || 'finance-v12'; st.cp = st.cp || 'model-output'; st.rule = st.rule || 'no-legal-advice'; st.view = st.view || 'form'; st.edits = st.edits || {}; st.promoted = st.promoted || {}; st.testText = st.testText || {};
      const profile = PROFILES.find((p) => p.id === st.profile) || PROFILES[0];
      const rulesHere = RULES.filter((r) => r.cp === st.cp && (profile.id !== 'platform-v4' || r.baseline));
      let rule = RULES.find((r) => r.id === st.rule && r.cp === st.cp); if (!rule) { rule = rulesHere[0]; st.rule = rule ? rule.id : null; }
      const ed = rule ? (st.edits[rule.id] || {}) : {};
      const thr = ed.threshold != null ? ed.threshold : (rule && rule.threshold) || '';
      const action = ed.action || (rule && rule.action) || 'warn';
      const pattern = ed.pattern != null ? ed.pattern : (rule && rule.pattern) || '';
      const dirty = rule && Object.keys(ed).length > 0;
      const locked = rule && rule.baseline && profile.id !== 'platform-v4';
      const stage = rule ? (st.promoted[rule.id] || rule.stage) : '';
      const thrNum = parseFloat(thr);
      const isLegal = rule && rule.id === 'no-legal-advice';
      const fp = isLegal && !isNaN(thrNum) ? fpFor(thrNum) : null;
      const test = rule ? (TESTS[rule.id] || TESTS.default) : TESTS.default;
      const custom = rule ? st.testText[rule.id] : null;
      const testHit = rule ? (rule.pattern != null ? (custom ? new RegExp('BEGIN|AKIA|sk-|password|api[_-]?key|requests|fetch', 'i').test(custom) : true) : (rule.id === 'numeric-grounding' || rule.id === 'cite-kb' ? true : isNaN(thrNum) ? test.score > 0.5 : test.score >= thrNum)) : false;
      const actionWord = { block: 'block', warn: 'warn', redact: 'redact', flag: 'flag', log: 'log', allow: 'allow', 'require-approval': 'ask for approval', reroute: 'reroute' }[action] || action;

      const cols = ['Rule', 'Type', 'Action', 'Stage', { label: 'Triggers', right: true }, { label: 'False pos.', right: true }, { label: 'Latency', right: true }, 'On error'];
      const actionPill = (a) => UI.pill(a, a === 'block' ? 'danger' : a === 'warn' || a === 'redact' ? 'warn' : a === 'flag' || a === 'require-approval' ? 'info' : a === 'allow' ? 'ok' : '');
      const rows = rulesHere.map((r) => ({ cells: [esc(r.name) + (r.baseline ? ' ' + UI.icon('lock', 11) : ''), esc(r.type), actionPill(st.edits[r.id] && st.edits[r.id].action || r.action), UI.pill(st.promoted[r.id] || r.stage, (st.promoted[r.id] || r.stage) === 'enforce' ? 'ok' : 'info'), esc(r.triggers), esc(r.id === 'no-legal-advice' && fp != null ? fp.toFixed(1) + '%' : r.fp), esc(r.latency), esc(r.onError)], attrs: 'data-rule="' + r.id + '"', selected: rule && r.id === rule.id }));

      const formView = '<div class="formgrid" style="--cols:3">'
        + UI.field('Mechanism', UI.select([rule.mechanism, 're2 pattern', 'embedding similarity', 'classifier', 'llama-guard3:8b', 'detector pii.*'].filter((v, i, a) => a.indexOf(v) === i), rule.mechanism, 'data-edit="mechanism"' + (locked ? ' disabled' : '')))
        + (rule.pattern != null
          ? UI.field('Pattern (RE2)', UI.input(pattern, { attrs: 'class="input mono" data-edit="pattern"' + (locked ? ' disabled' : '') }), st.patternError && rule.id === 'script-secrets' ? '<span style="color:var(--danger-fg)">Position ' + st.patternError.pos + ': ' + esc(st.patternError.msg) + '</span>' : 'Compiled with RE2, so it cannot backtrack catastrophically.')
          : UI.field('Threshold', UI.input(thr, { attrs: 'class="input mono" data-edit="threshold"' + (locked ? ' disabled' : '') }), isLegal ? 'Raising it lowers both triggers and false positives. Shadow replay below updates.' : ''))
        + UI.field('Action', UI.select(['allow', 'log', 'warn', 'redact', 'flag', 'block', 'require-approval', 'reroute'], action, 'data-edit="action"' + (locked ? ' disabled' : '')), locked ? 'The most restrictive result across baseline, tenant, workspace and agent wins.' : '')
        + '</div>'
        + (st.patternError && rule.id === 'script-secrets' ? UI.notice('<b>RE2 rejected the pattern.</b> Backreferences like <span class="mono">\\2</span> are not supported. An equivalent without one: <span class="mono">' + esc(st.patternError.fix) + '</span>', 'danger', UI.btn('Use equivalent', { size: 'sm', attrs: 'data-usefix' })) : '');
      const yamlView = UI.code(yamlFor(rule, thr, action) + (rule.pattern != null && pattern !== rule.pattern ? '\n# edited: pattern' : ''), 'yaml') + '<div class="muted" style="font-size:12px">The YAML and the form are the same rule. Edits here are validated against the GuardrailRule schema on save.</div>';

      const testPane = '<div class="panel" style="width:300px;flex-shrink:0;gap:8px" data-testpane><div class="phead"><div class="eyebrow">Live test</div>' + UI.btn('Edit sample', { kind: 'ghost', size: 'xs', attrs: 'data-editsample' }) + '</div>'
        + (st.editSample ? '<textarea class="textarea" data-sample rows="3">' + esc(custom || (test.before + test.span + test.after)) + '</textarea><div class="hstack">' + UI.btn('Test', { kind: 'primary', size: 'sm', attrs: 'data-runtest' }) + UI.btn('Reset', { kind: 'ghost', size: 'sm', attrs: 'data-resetsample' }) + '</div>'
          : (custom ? '<div>' + (testHit ? esc(custom).replace(/(BEGIN[^\n]{0,40}|AKIA\w{16}|sk-\w{8,}|password\s*=\s*\S+|api[_-]?key\s*=\s*\S+|\d[\d,\.]*\s?(%|EUR))/i, '<mark style="background:var(--warn-bg);color:inherit">$1</mark>') : esc(custom)) + '</div>' : '<div>' + esc(test.before) + '<mark style="background:var(--warn-bg);color:inherit">' + esc(test.span) + '</mark>' + esc(test.after) + '</div>'))
        + '<div style="font-size:12px;color:var(--' + (testHit ? (action === 'block' ? 'danger-fg' : 'warn-fg') : 'ok-fg') + ')">' + (testHit ? 'Would ' + esc(actionWord) + ', ' + esc(test.unit) + ' ' + (rule.id === 'numeric-grounding' ? '0.00: 71% has no calc result' : rule.id === 'cite-kb' ? '0 in this turn' : test.score.toFixed(2)) : 'Would allow, ' + esc(test.unit) + ' ' + test.score.toFixed(2) + ' below ' + esc(thr)) + '</div>'
        + '<div class="muted" style="font-size:12px">Runs on the gateway with this draft, not the published rule. Nothing is logged.</div></div>';

      const editor = rule ? UI.panel('Rule editor: ' + rule.name, (locked ? UI.notice('<b>Locked.</b> This rule belongs to the platform baseline (owner: Platform guardrail admins). A tenant admin can add stricter rules but cannot relax it.' + (st.lockTried ? ' Your change to the action was not applied.' : ''), 'warn', '<a href="#" data-reqchange>Request a change</a>') : '')
        + (st.pendingApproval && st.pendingApproval.rule === rule.id ? UI.notice('Change proposed by <b>' + esc(st.pendingApproval.by) + '</b> at ' + esc(st.pendingApproval.at) + ' (' + esc(st.pendingApproval.change) + ') waits for a second guardrail admin. You cannot approve your own change.', 'info') : '')
        + '<div class="cols"><div class="grow vstack" style="gap:10px">' + (st.view === 'yaml' ? yamlView : formView) + '</div>' + testPane + '</div>'
        + '<div class="hstack wrap"><span class="muted" style="font-size:12px">Version ' + (rule.baseline ? 'platform v4' : profile.name + ' v' + profile.version) + ' · every change is versioned with a diff' + (dirty ? ' · <span style="color:var(--warn-fg)">unsaved edit</span>' : '') + '</span><span class="right hstack gap6">' + UI.btn('Shadow replay this draft', { size: 'sm', attrs: 'data-replay' }) + UI.btn('Discard', { kind: 'ghost', size: 'sm', attrs: 'data-discard', disabled: !dirty }) + UI.btn('Save draft', { kind: 'primary', size: 'sm', attrs: 'data-save', disabled: !dirty || locked }) + '</span></div>',
        { actions: UI.seg([{ id: 'form', label: 'Form' }, { id: 'yaml', label: 'YAML' }], st.view, 'data-viewseg') }) : '';

      const replay = rule ? UI.panel('Shadow replay, last 7 days', UI.kv([
        ['Turns replayed', '18,204'],
        ['Would have ' + (action === 'block' ? 'blocked' : action === 'warn' ? 'warned' : action === 'redact' ? 'redacted' : action === 'flag' ? 'flagged' : 'acted'), isLegal && fp != null ? wouldFor(thrNum).toLocaleString('en-GB') : String(Math.round(18204 * parseFloat(rule.triggers) / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')],
        ['Reviewer sample', isLegal && fp != null ? Math.round(fp) + ' of 100 were false positives' : Math.round(parseFloat(rule.fp)) + ' of 100 were false positives'],
        ['Added latency', esc(rule.latency) + ' median']
      ], 4) + ((isLegal ? fp : parseFloat(rule.fp)) > 10 ? '<div style="font-size:12px;color:var(--danger-fg)">False-positive rate is above the 10% promotion limit. Raise the threshold or narrow the examples before enforcing.</div>' : '<div style="font-size:12px;color:var(--ok-fg)">False-positive rate is within the 10% promotion limit.' + (stage === 'shadow' ? ' This rule can be promoted to enforce.' : '') + '</div>')
        + (st.replayRan === rule.id ? UI.notice('Replay of the draft finished: ' + (isLegal ? wouldFor(thrNum).toLocaleString('en-GB') : Math.round(18204 * parseFloat(rule.triggers) / 100)) + ' turns would have been affected. 100 were sampled for review.', 'ok', '<a href="#" data-goflags>Open the review sample</a>') : '')) : '';

      const reviewbar = st.pendingApproval ? UI.reviewbar('<b>Second approver needed.</b> ' + esc(st.pendingApproval.by) + ' proposed a change to the platform baseline (' + esc(st.pendingApproval.change) + '). It applies when another guardrail admin approves.', UI.btn('Approve', { size: 'sm', attrs: 'data-approve', disabled: st.pendingApproval.by === 'Mara Okafor', title: 'You cannot approve your own change' }) + UI.btn('Withdraw', { kind: 'ghost', size: 'sm', attrs: 'data-withdraw' }))
        : profile.status === 'draft' ? UI.reviewbar('<b>Draft v13</b> of Finance baseline: ' + Object.keys(st.edits).length + ' edited rule' + (Object.keys(st.edits).length === 1 ? '' : 's') + ' since v12. Test against the red-team and benign sets, then run in shadow before enforcing.', UI.btn('View diff', { size: 'sm', attrs: 'data-diff' }) + UI.btn('Request review', { kind: 'primary', size: 'sm', attrs: 'data-reqreview' })) : '';

      root.innerHTML = '<style>'
        + '#main > .page > *{flex-shrink:0}'
        + '#main .gr-list{display:flex;flex-direction:column;gap:2px}'
        + '#main mark{border-radius:2px;padding:0 1px}'
        + '</style>'
        + '<div class="leftpane"><div class="eyebrow">Profile: ' + esc(profile.name) + ' v' + profile.version + '</div>'
        + UI.select(PROFILES.map((p) => ({ value: p.id, label: p.name + ' v' + p.version + ' (' + p.status + ')' })), profile.id, 'data-profile aria-label="Profile"')
        + '<div class="muted" style="font-size:12px">' + esc(profile.scope) + ' · owner ' + esc(profile.owner) + (profile.locked ? ' · read-only for tenant admins' : '') + '</div>'
        + '<div class="gr-list">' + CHECKPOINTS.map((c) => { const n = RULES.filter((r) => r.cp === c.id && (profile.id !== 'platform-v4' || r.baseline)).length; return UI.listItem(esc(c.label), n + ' rule' + (n === 1 ? '' : 's'), { active: c.id === st.cp, attrs: 'data-cp="' + c.id + '"' }); }).join('') + '</div>'
        + '<div class="divider"></div>' + UI.btn('Add rule', { icon: 'plus', size: 'sm', cls: 'block', attrs: 'data-addrule' + (profile.locked ? ' disabled' : '') }) + '</div>'
        + '<div class="page">'
        + UI.pagehead('Guardrails', 'Guard model runs on the full answer by default, and sentence by sentence for confidential and above or turns that can call tools', UI.btn('View diff', { attrs: 'data-diff' }) + UI.btn('Promote to enforce', { kind: 'primary', attrs: 'data-promote', disabled: !rule || stage === 'enforce' }))
        + (st.guardDown ? UI.notice('<b>Guard model down, failing closed.</b> llama-guard3:8b on gpu-small-1 has not answered since 14:02. Confidential and tool-calling turns are held; 12 turns elsewhere fell open under <span class="mono">onError: allow</span> and were flagged.', 'danger', '<a href="#" data-goflags>Flags</a> <a href="#" data-gopools>Pools</a>') : '')
        + reviewbar
        + '<div class="hstack"><div class="eyebrow">' + esc(CHECKPOINTS.find((c) => c.id === st.cp).label) + ' checkpoint</div><span class="muted" style="font-size:12px">' + UI.pill(profile.status === 'published' ? 'v' + profile.version + ' published' : 'v' + profile.version + ' draft') + '</span><span class="right muted" style="font-size:12px">Precedence: platform baseline, tenant, workspace, agent. The most restrictive result wins.</span></div>'
        + UI.table(cols, rows, { minWidth: '760px', emptyTitle: 'No rules at this checkpoint', emptyText: 'Add a rule or pick another checkpoint.' })
        + editor + replay
        + '<div style="margin-top:auto"><div class="eyebrow" style="margin-bottom:8px">States to design from this page</div>' + UI.states(this.states) + '</div></div>';

      if (st.focusTest) { st.focusTest = false; const p = ctx.$('[data-testpane]'); if (p) { p.scrollIntoView({ block: 'center' }); p.style.outline = '2px solid var(--accent)'; setTimeout(() => { p.style.outline = ''; }, 1600); } ctx.toast('Live test runs the draft rule on the sample. Edit the sample to try your own text.'); }

      // ---- events ----
      ctx.on('change', '[data-profile]', (e, t) => { st.profile = t.value; st.lockTried = false; ctx.rerender(); });
      ctx.on('click', '[data-cp]', (e, t) => { st.cp = t.dataset.cp; st.rule = null; st.lockTried = false; ctx.rerender(); });
      ctx.on('click', 'tr.row[data-rule]', (e, t) => { st.rule = t.dataset.rule; st.lockTried = false; st.editSample = false; ctx.rerender(); });
      ctx.on('click', '[data-viewseg] [data-seg]', (e, t) => { st.view = t.dataset.seg; ctx.rerender(); });
      ctx.on('change', '[data-edit]', (e, t) => { if (!rule) return; if (locked) { st.lockTried = true; ctx.rerender(); return; } st.edits[rule.id] = st.edits[rule.id] || {}; st.edits[rule.id][t.dataset.edit] = t.value; if (t.dataset.edit === 'pattern' && /\\[1-9]/.test(t.value)) { st.patternError = { pos: t.value.search(/\\[1-9]/), msg: 'invalid escape sequence: \\' + t.value.match(/\\([1-9])/)[1] + ' (backreferences are not supported by RE2)', fix: t.value.replace(/\(([^)]*)\)(.*)\\[1-9]/, '$1$2$1') }; } else if (t.dataset.edit === 'pattern') st.patternError = null; ctx.rerender(); });
      ctx.on('click', '[data-usefix]', () => { st.edits[rule.id].pattern = st.patternError.fix; st.patternError = null; ctx.rerender(); ctx.toast('Pattern replaced. RE2 compiles it in 0.1 ms.', 'ok'); });
      ctx.on('click', '[data-discard]', () => { delete st.edits[rule.id]; st.patternError = null; ctx.rerender(); });
      ctx.on('click', '[data-save]', () => { if (st.patternError) { ctx.toast('Cannot save: the pattern does not compile under RE2.', 'danger'); return; } const target = profile.status === 'draft' ? profile : PROFILES[1]; ctx.toast('Saved to ' + esc(target.name) + ' v' + target.version + ' (draft) with a diff against v12. Audit entry written.', 'ok'); st.profile = target.id; ctx.rerender(); });
      ctx.on('click', '[data-editsample]', () => { st.editSample = !st.editSample; ctx.rerender(); });
      ctx.on('input', '[data-sample]', (e, t) => { st.testText[rule.id] = t.value; });
      ctx.on('click', '[data-runtest]', () => { st.editSample = false; ctx.rerender(); ctx.toast('Tested on the gateway with the draft rule.'); });
      ctx.on('click', '[data-resetsample]', () => { delete st.testText[rule.id]; st.editSample = false; ctx.rerender(); });
      ctx.on('click', '[data-replay]', () => { ctx.toast('Replaying the draft over 7 days of stored traffic (18,204 turns)…'); setTimeout(() => { st.replayRan = rule.id; ctx.rerender(); }, 1200); });
      ctx.on('click', '[data-promote]', async () => {
        if (!rule) return;
        const rate = isLegal && fp != null ? fp : parseFloat(rule.fp);
        const ok = await ctx.confirm({ title: 'Promote to enforce', tag: rate > 10 ? 'blocked' : 'enforce', tone: rate > 10 ? 'danger' : 'info', body: rate > 10 ? UI.notice('False-positive rate ' + rate.toFixed(1) + '% is above the 10% promotion limit. Promotion is refused until a shadow replay of a narrower rule passes.', 'danger') : '<p style="margin:0" class="fg2">The rule leaves shadow mode and its action applies to live traffic. The change is versioned and audited.</p>', kv: [['Rule', esc(rule.name)], ['Action', esc(action)], ['Shadow false positives', rate.toFixed(1) + '%'], ['Added latency', esc(rule.latency)]], ok: rate > 10 ? 'Try anyway' : 'Promote' });
        if (!ok) return;
        if (rate > 10) { ctx.toast('Promotion refused: false-positive rate ' + rate.toFixed(1) + '% is above the 10% limit.', 'danger', 5000); return; }
        if (locked) { ctx.toast('Refused: platform baseline rules are promoted by platform guardrail admins.', 'warn'); return; }
        st.promoted[rule.id] = 'enforce'; ctx.rerender(); ctx.toast(esc(rule.name) + ' now enforces in ' + esc(profile.name) + ' v' + (profile.version + (profile.status === 'draft' ? 0 : 1)) + '. Audit entry written.', 'ok');
      });
      ctx.on('click', '[data-diff]', () => ctx.modal({ cls: 'wide', title: 'Diff: Finance baseline v12 to v13 (draft)', body: '<div class="muted" style="font-size:12px">' + (Object.keys(st.edits).length || 1) + ' rule' + (Object.keys(st.edits).length === 1 ? '' : 's') + ' changed. Every published version keeps its diff.</div>' + UI.code(' id: no-legal-advice\n checkpoint: model-output\n type: topic\n mechanism: embedding\n-threshold: 0.78\n+threshold: ' + (st.edits['no-legal-advice'] && st.edits['no-legal-advice'].threshold || '0.85') + '\n action: warn\n onError: allow\n' + (st.edits['script-secrets'] ? '\n id: hard-coded-credentials\n-pattern: (?i)(password|api[_-]?key)\\s*=\\s*[\'"][^\'"]{8,}\n+pattern: ' + esc(st.edits['script-secrets'].pattern || '') + '\n' : ''), 'diff'), actions: UI.btn('Close', { attrs: 'data-close' }) }));
      ctx.on('click', '[data-reqreview]', () => { ctx.toast('Review requested. A second guardrail admin is notified; the draft runs in shadow meanwhile.', 'ok'); });
      ctx.on('click', '[data-reqchange]', (e) => { e.preventDefault(); ctx.modal({ title: 'Request a change to the platform baseline', body: UI.field('Rule', UI.input(rule.name, { readonly: true })) + UI.field('Proposed change', UI.textarea('', { placeholder: 'What should change, and why. The owning admins see this with your workspace context.', rows: 3 })) + UI.notice('Platform guardrail admins own this rule. Tenant profiles can only add stricter rules on top of it.', 'info'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Send request', { kind: 'primary', attrs: 'data-sendreq' }), onMount(m) { m.querySelector('[data-sendreq]').addEventListener('click', () => { App.closeOverlay(); ctx.toast('Request sent to Platform guardrail admins.', 'ok'); }); } }); });
      ctx.on('click', '[data-approve]', () => { st.pendingApproval = null; ctx.rerender(); ctx.toast('Approved. Platform baseline v5 is published to every tenant.', 'ok'); });
      ctx.on('click', '[data-withdraw]', () => { st.pendingApproval = null; ctx.rerender(); ctx.toast('Change withdrawn. Platform baseline stays at v4.'); });
      ctx.on('click', '[data-addrule]', () => ctx.modal({ title: 'Add rule to ' + esc(CHECKPOINTS.find((c) => c.id === st.cp).label), body: '<div class="formgrid">' + UI.field('Name', UI.input('', { placeholder: 'for example flag-customer-ids-on-transfer' })) + UI.field('Type', UI.select(['pattern', 'PII', 'topic policy', 'safety', 'prompt injection', 'grounding', 'budget'], 'PII')) + UI.field('Action', UI.select(['allow', 'log', 'warn', 'redact', 'flag', 'block', 'require-approval', 'reroute'], 'flag')) + UI.field('Severity', UI.select(['low', 'medium', 'high'], 'medium')) + '</div>' + UI.notice('New rules start as drafts in shadow mode. They enforce only after a test run and a replay.', 'info'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Create draft', { kind: 'primary', attrs: 'data-create' }), onMount(m) { m.querySelector('[data-create]').addEventListener('click', () => { App.closeOverlay(); const id = 'new-' + Date.now(); RULES.push({ id, name: m.querySelector('input').value || 'New rule', cp: st.cp, type: m.querySelectorAll('select')[0].value, action: m.querySelectorAll('select')[1].value, stage: 'shadow', triggers: '0.0%', fp: '0.0%', latency: '0 ms', onError: 'allow', mechanism: 'detector pii.*', threshold: '0.80' }); st.rule = id; st.profile = 'finance-v13'; ctx.rerender(); ctx.toast('Draft rule created in Finance baseline v13. It runs in shadow.', 'ok'); }); } }));
      ctx.on('click', '[data-goflags]', (e) => { e.preventDefault(); ctx.navigate('flags', { id: 'F-2291' }); });
      ctx.on('click', '[data-gopools]', (e) => { e.preventDefault(); ctx.navigate('pools'); });
      ctx.on('click', '.state-card', (e, t) => ctx.app.applyState(+t.dataset.state));
    }
  });
})();
