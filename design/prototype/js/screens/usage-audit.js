(function () {
  const { UI, esc } = App;

  // ---------- data ----------
  const DAYS = ['6 Sep', '7 Sep', '8 Sep', '9 Sep', '10 Sep', '11 Sep', '12 Sep', '13 Sep', '14 Sep', '15 Sep', '16 Sep', '17 Sep', '18 Sep', '19 Sep'];
  const TOKENS = [199, 227, 185, 247, 297, 275, 107, 83, 292, 329, 317, 338, 285, 310]; // thousands, Finance Ops
  const EXACT = [198640, 226910, 185020, 247380, 296700, 275110, 106880, 82940, 291560, 329020, 316740, 337910, 284600, 310120];

  const USAGE = {
    user: [
      { who: 'Data analyst agent', kind: 'agent', model: 'qwen2.5:32b', full: 'qwen2.5:32b-q4_K_M', prompt: 1204100, out: 311420, gpu: 4120, mix: '62% / 31% / 7%', profile: 'analyst', convo: 'c4' },
      { who: 'Mara Okafor', kind: 'user', model: 'qwen2.5:32b', full: 'qwen2.5:32b-q4_K_M', prompt: 402880, out: 96310, gpu: 1310, mix: '88% / 10% / 2%', profile: 'analyst', convo: 'c1' },
      { who: 'svc-close-bot', kind: 'service account', model: 'llama3.1:8b', full: 'llama3.1:8b-q5_K_M', prompt: 288000, out: 41200, gpu: 402, mix: '100% / 0% / 0%', profile: 'fast', convo: null }
    ],
    model: [
      { who: 'qwen2.5:32b-q4_K_M', kind: 'model', model: 'gpu-large', full: 'qwen2.5:32b-q4_K_M', prompt: 1606980, out: 407730, gpu: 5430, mix: '69% / 26% / 5%' },
      { who: 'llama3.1:8b-q5_K_M', kind: 'model', model: 'gpu-small', full: 'llama3.1:8b-q5_K_M', prompt: 288000, out: 41200, gpu: 402, mix: '100% / 0% / 0%' },
      { who: 'bge-m3 (embed)', kind: 'model', model: 'cpu-pool', full: 'bge-m3', prompt: 1922400, out: 0, gpu: 0, mix: '- / - / -' }
    ],
    tenant: [
      { who: 'Northwind', kind: 'tenant', model: '3 workspaces', full: '', prompt: 3817380, out: 448930, gpu: 5832, mix: '71% / 24% / 5%' },
      { who: 'Contoso Freight', kind: 'tenant', model: '1 workspace', full: '', prompt: 118200, out: 22040, gpu: 118, mix: '90% / 10% / 0%' }
    ]
  };

  const EVENTS = [
    { time: '14:02:19', actor: 'M. Okafor', actorFull: 'Mara Okafor, via Data analyst agent', action: 'tool.confirmed', target: 'jira-internal.create_issue', label: 'confidential', hash: '9e02a41c', prev: 'b7709d15', decision: 'allowed by policy v31', trace: '4bf92f3577b34da6a3ce929d0e0e4736', kind: 'decision', convo: 'c1',
      json: { id: 'evt_01J8Q4M2R9K7', ts: '2026-09-19T14:02:19.418Z', tenant: 'northwind', workspace: 'finance-ops', actor: { user: 'mokafor', name: 'Mara Okafor', via: 'agent:data-analyst', session: 'ses_7c1e' }, action: 'tool.confirmed', target: { tool: 'jira-internal.create_issue', server: 'jira-internal', args_digest: 'sha256:5a1f…c02e' }, label: 'confidential', decision: { result: 'allowed', policy: 'finance-baseline v31', scopes: ['tools:invoke'], role: 'member', clearance: 'confidential', zone: 'sandbox' }, trace_id: '4bf92f3577b34da6a3ce929d0e0e4736', prev_hash: 'b7709d15', hash: '9e02a41c' } },
    { time: '13:40:02', actor: 'ci-pipeline', actorFull: 'ci-pipeline (service account)', action: 'zone.check.passed', target: 'inference', label: 'internal', hash: '13fd77b0', prev: '9a6b1e02', decision: 'no Ollama port answers from outside the inference zone', trace: '0c7d3a9e4f1b2c5d8e6f7a8b9c0d1e2f', kind: 'system',
      json: { id: 'evt_01J8Q3H0ZC4A', ts: '2026-09-19T13:40:02.007Z', tenant: 'platform', actor: { service: 'ci-pipeline' }, action: 'zone.check.passed', target: { zone: 'inference', probe: 'ollama-port-exposure', nodes_probed: 6, answered_from_outside: 0 }, label: 'internal', trace_id: '0c7d3a9e4f1b2c5d8e6f7a8b9c0d1e2f', prev_hash: '9a6b1e02', hash: '13fd77b0' } },
    { time: '12:11:47', actor: 'T. Wieczorek', actorFull: 'Tomasz Wieczorek', action: 'guardrail.rule.updated', target: 'no-legal-advice v3', label: 'internal', hash: 'c81e9f2c', prev: '2f0e8d11', decision: 'guardrail admin, Finance baseline', trace: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', kind: 'admin',
      json: { id: 'evt_01J8PZ9K2M1X', ts: '2026-09-19T12:11:47.902Z', tenant: 'northwind', actor: { user: 'twieczorek', name: 'Tomasz Wieczorek', role: 'guardrail admin' }, action: 'guardrail.rule.updated', target: { profile: 'finance-baseline', rule: 'no-legal-advice', version: 3 }, diff: { pattern: { from: '(?i)legal advice', to: '(?i)legal (advice|opinion)' } }, label: 'internal', trace_id: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', prev_hash: '2f0e8d11', hash: 'c81e9f2c' } },
    { time: '12:11:50', actor: 'T. Wieczorek', actorFull: 'Tomasz Wieczorek', action: 'audit.correction', target: 'corrects c81e9f2c', label: 'internal', hash: '44c1e90a', prev: 'c81e9f2c', decision: 'compensating row; the original is unchanged', trace: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', kind: 'correction', corrects: 'c81e9f2c',
      json: { id: 'evt_01J8PZ9N7T0Q', ts: '2026-09-19T12:11:50.114Z', tenant: 'northwind', actor: { user: 'twieczorek', name: 'Tomasz Wieczorek' }, action: 'audit.correction', corrects: 'c81e9f2c', reason: 'Rule version recorded as 3; the saved version is 4.', correction: { target: { version: 4 } }, label: 'internal', trace_id: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', prev_hash: 'c81e9f2c', hash: '44c1e90a' } },
    { time: '06:00:03', actor: 'directory-sync', actorFull: 'directory-sync (scheduled)', action: 'user.disabled', target: 'j.lindqvist', label: 'internal', hash: '7a201f3d', prev: '5e77ab04', decision: 'removed from cn=finops-analysts; 2 sessions and 1 refresh token revoked', trace: 'f0e1d2c3b4a5968778695a4b3c2d1e0f', kind: 'system',
      json: { id: 'evt_01J8P8W1H6ZD', ts: '2026-09-19T06:00:03.551Z', tenant: 'northwind', actor: { service: 'directory-sync', schedule: 'hourly' }, action: 'user.disabled', target: { user: 'j.lindqvist', reason: 'not found in directory', groups_removed: ['cn=finops-analysts,ou=groups,ou=northwind'] }, revoked: { sessions: 2, refresh_tokens: 1 }, label: 'internal', trace_id: 'f0e1d2c3b4a5968778695a4b3c2d1e0f', prev_hash: '5e77ab04', hash: '7a201f3d' } }
  ];

  const EXPORTS = [
    { file: 'audit-northwind-2026-09-12.csv', scope: 'Northwind, 5 to 12 Sep, internal and below', rows: '28,114', by: 'Mara Okafor', state: 'ready' },
    { file: 'usage-finance-ops-2026-08.csv', scope: 'Finance Ops, August, per user and model', rows: '1,206', by: 'Mara Okafor', state: 'ready' },
    { file: 'audit-siem-stream', scope: 'All tenants, continuous, exprsn.events', rows: 'streaming', by: 'platform', state: 'connected' }
  ];

  const QUOTAS = [
    { scope: 'Finance Ops', tokensDay: '3.1M of 5M', tokensPct: 62, gpu: '16,380 of 18,000', gpuPct: 91, train: '136 of 200', trainPct: 68, raise: 'tenant admin' },
    { scope: 'People Ops', tokensDay: '410k of 2M', tokensPct: 21, gpu: '2,140 of 6,000', gpuPct: 36, train: '0 of 20', trainPct: 0, raise: 'tenant admin' },
    { scope: 'Field Sales', tokensDay: '1.9M of 2M', tokensPct: 95, gpu: '4,980 of 6,000', gpuPct: 83, train: '0 of 0', trainPct: 0, raise: 'tenant admin' },
    { scope: 'Platform lab (Contoso)', tokensDay: '118k of 1M', tokensPct: 12, gpu: '118 of 2,000', gpuPct: 6, train: '12 of 40', trainPct: 30, raise: 'system admin' }
  ];

  const fmt = (n) => n.toLocaleString('en-US');

  // 1.6.0 (Sprint 38c): the Compliance tab: DLP rules and patterns (B-7601), legal holds (B-7602), compliance exports (B-7603).
  const DLP0 = {
    patterns: [{ id: 'pat-1', name: 'Project codes', pattern: 'PROJ-\\d{4}', label: 'confidential', enabled: true }, { id: 'pat-2', name: 'Customer numbers', pattern: 'NW-C-\\d{6}', label: 'internal', enabled: true }],
    rules: [
      { id: 'dlp-1', name: 'Payment cards', enabled: true, detectors: ['payment_card', 'iban'], raiseTo: 'confidential', action: 'redact', scopes: ['answer', 'agent', 'upload'], hits: 14 },
      { id: 'dlp-2', name: 'Secrets', enabled: true, detectors: ['private_key', 'cloud_access_key', 'bearer_token'], raiseTo: 'restricted', action: 'hold', scopes: ['answer', 'agent', 'upload'], hits: 2 },
      { id: 'dlp-3', name: 'Project codes', enabled: true, detectors: ['pattern:pat-1'], raiseTo: 'confidential', action: 'label', scopes: ['answer', 'upload'], hits: 31 },
      { id: 'dlp-4', name: 'National identifiers', enabled: false, detectors: ['national_id'], raiseTo: 'confidential', action: 'redact', scopes: ['answer'], hits: 0 }
    ]
  };
  const DETECTORS = ['email', 'phone', 'iban', 'payment_card', 'national_id', 'private_key', 'cloud_access_key', 'bearer_token', 'high_entropy'];
  const HOLDS0 = [
    { id: 'lh-1', scope: 'user', subject: 'Jonas Lindqvist', reason: 'Litigation 2026-17 (Contoso Freight): preserve every conversation, file and memory.', state: 'active', requestedBy: 'Mara Okafor', approver: 'Tomasz Wieczorek', decidedAt: '12 Sep 09:40', createdAt: '11 Sep 17:02' },
    { id: 'lh-2', scope: 'workspace', subject: 'Field Sales', reason: 'Regulator request FCA-2026-0912: pricing conversations since May.', state: 'pending', requestedBy: 'Mara Okafor', approver: 'Tomasz Wieczorek', decidedAt: null, createdAt: '19 Sep 13:55' },
    { id: 'lh-3', scope: 'user', subject: 'Dami Okonkwo', reason: 'Internal investigation closed.', state: 'released', requestedBy: 'Tomasz Wieczorek', approver: 'Mara Okafor', decidedAt: '2 Jul 10:10', releasedAt: '30 Aug 16:20', createdAt: '1 Jul 11:30' }
  ];
  const CEXPORTS0 = [
    { id: 'cx-1', scope: 'user j.lindqvist, 1 Jan to 19 Sep 2026, conversations files memories runs users', state: 'ready', label: 'confidential', counts: '38 conversations, 412 messages, 9 files, 14 memories, 3 runs, 1 user', omitted: 0, by: 'eDiscovery token (Relativity)', createdAt: '19 Sep 09:12' },
    { id: 'cx-2', scope: 'workspace Field Sales, 1 May to 19 Sep 2026, conversations users', state: 'ready', label: 'restricted', counts: '1,204 conversations, 15,880 messages, 27 users', omitted: 212, by: 'Mara Okafor', createdAt: '19 Sep 13:58' },
    { id: 'cx-3', scope: 'user d.okonkwo, 1 Jun to 31 Aug 2026', state: 'failed', label: 'public', counts: '', omitted: 0, by: 'Tomasz Wieczorek', createdAt: '30 Aug 16:00', error: 'More than 100,000 rows match (COMPLIANCE_EXPORT_MAX_ROWS); narrow the range.' }
  ];
  const APPROVERS = ['Tomasz Wieczorek', 'Priya Nair'];
  const ME = 'Mara Okafor';

  function tryDlp(st, text) {
    const rules = st.dlp.rules.filter((r) => r.enabled && r.scopes.includes(st.dlpScope || 'answer'));
    const found = [];
    const tests = { payment_card: /\b(?:\d[ -]?){12,18}\d\b/, iban: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}\b/, email: /[\w.+-]+@[\w-]+\.[a-z]{2,}/i, phone: /\+?\d[\d ()-]{8,}\d/, national_id: /\b\d{3}-\d{2}-\d{4}\b/, private_key: /BEGIN [A-Z ]*PRIVATE KEY/, cloud_access_key: /\bAKIA[0-9A-Z]{16}\b/, bearer_token: /\b(?:sk|xox[bp]|ghp)[-_][A-Za-z0-9_-]{12,}/, high_entropy: /\b[A-Za-z0-9+/]{40,}={0,2}\b/ };
    let label = st.dlpLabel || 'internal', action = null, out = text;
    const rank = { public: 0, internal: 1, confidential: 2, restricted: 3 }, arank = { label: 0, redact: 1, hold: 2 };
    for (const r of rules) {
      const kinds = [];
      for (const d of r.detectors) {
        const pat = d.startsWith('pattern:') ? st.dlp.patterns.find((p) => p.id === d.slice(8)) : null;
        const re = pat ? new RegExp(pat.pattern, 'g') : tests[d] ? new RegExp(tests[d].source, 'g' + (tests[d].flags || '')) : null;
        if (re && re.test(out)) { kinds.push(pat ? 'pattern:' + pat.name : d); if (r.action === 'redact') out = out.replace(re, '[redacted ' + (pat ? 'pattern:' + pat.name : d.replace(/_/g, ' ')) + ']'); if (pat && rank[pat.label] > rank[label]) label = pat.label; }
      }
      if (!kinds.length) continue;
      if (rank[r.raiseTo] > rank[label]) label = r.raiseTo;
      if (!action || arank[r.action] > arank[action]) action = r.action;
      found.push({ rule: r.name, kinds, action: r.action });
    }
    return { label, action, text: action === 'redact' ? out : text, found };
  }

  function renderCompliance(ctx, st) {
    const dlpRows = st.dlp.rules.map((r) => ({ cells: ['<b>' + esc(r.name) + '</b>', esc(r.detectors.map((d) => d.startsWith('pattern:') ? 'pattern ' + ((st.dlp.patterns.find((p) => p.id === d.slice(8)) || {}).name || d) : d.replace(/_/g, ' ')).join(', ')), UI.label(r.raiseTo, { sm: true }), UI.pill(r.action, r.action === 'hold' ? 'danger' : r.action === 'redact' ? 'warn' : 'info'), esc(r.scopes.join(', ')), String(r.hits), UI.pill(r.enabled ? 'enabled' : 'off', r.enabled ? 'ok' : ''), UI.btn('Edit', { size: 'xs', kind: 'ghost', attrs: 'data-dlpedit="' + r.id + '"' }) + ' ' + UI.btn(r.enabled ? 'Turn off' : 'Turn on', { size: 'xs', kind: 'ghost', attrs: 'data-dlptoggle="' + r.id + '"' })], attrs: 'data-row="' + r.id + '"' }));
    const patRows = st.dlp.patterns.map((p) => [esc(p.name), '<span class="mono">' + esc(p.pattern) + '</span>', UI.label(p.label, { sm: true }), UI.pill(p.enabled ? 'enabled' : 'off', p.enabled ? 'ok' : ''), UI.btn('Remove', { size: 'xs', kind: 'ghost', attrs: 'data-patdel="' + p.id + '"' })]);
    const tried = st.dlpTried ? tryDlp(st, st.dlpTried) : null;
    const dlp = UI.panel('DLP: classification of answers, agent outputs and uploads', UI.notice('A rule names what it detects (the built-in PII and secret detectors, and your own RE2 patterns), the label the content rises to, and what happens by that label: <b>label</b> raises it only, <b>redact</b> replaces the detected spans, <b>hold</b> keeps the answer for a reviewer (an upload is refused). The message, run, attachment or file version and the conversation carry the raised label; content raised above its owner\'s clearance is held whatever the rule says.', 'info')
      + UI.table(['Rule', 'Detects', 'Raises to', 'Action', 'Scopes', { label: 'Hits, 7 days', right: true }, 'State', { label: '', right: true }], dlpRows, { clickable: false, minWidth: '980px', emptyTitle: 'No DLP rules', emptyText: 'Answers and uploads keep the label of their conversation or workspace.' })
      + '<div class="hstack gap6 wrap" style="margin:8px 0 12px">' + UI.btn('New rule', { kind: 'primary', size: 'sm', icon: 'plus', attrs: 'data-dlpnew' }) + UI.btn('New pattern', { size: 'sm', icon: 'plus', attrs: 'data-patnew' }) + '</div>'
      + '<div class="eyebrow">Your patterns (RE2)</div>' + UI.table(['Pattern', 'Expression', 'Label', 'State', ''], patRows, { clickable: false, cls: 'bare', minWidth: '0', emptyTitle: 'No patterns', emptyText: 'Add one for project codes, customer numbers or anything the built-in detectors do not know.' })
      + '<div class="eyebrow" style="margin-top:12px">Try the rules</div><div class="formgrid">' + UI.field('Text', UI.textarea(st.dlpTried || '', { placeholder: 'The card on file is 4111 1111 1111 1111 for PROJ-4471', attrs: 'data-dlptext aria-label="Text to try"', rows: 3 })) + UI.field('Scope', UI.select(['answer', 'agent', 'upload'], st.dlpScope || 'answer', 'data-dlpscope aria-label="Scope"')) + '</div>'
      + '<div class="hstack gap6">' + UI.btn('Try', { size: 'sm', attrs: 'data-dlptry' }) + '<span class="muted" style="font-size:12px">Nothing is stored or audited.</span></div>'
      + (tried ? (tried.found.length ? UI.notice('<b>' + esc(tried.found.map((f) => f.rule).join(', ')) + '</b> fired on ' + esc(tried.found.flatMap((f) => f.kinds).join(', ')) + ': label ' + UI.label(tried.label, { sm: true }) + ', action <b>' + esc(tried.action) + '</b>.' + (tried.action === 'redact' ? '<div class="codebox" style="margin-top:6px">' + esc(tried.text) + '</div>' : ''), tried.action === 'hold' ? 'danger' : tried.action === 'redact' ? 'warn' : 'info') : UI.notice('No rule fired. The text keeps its label.', 'info')) : ''));

    const holdRows = st.holds.map((h) => ({ cells: ['<b>' + esc(h.subject) + '</b><div class="muted" style="font-size:12px">' + esc(h.scope) + '</div>', esc(h.reason), UI.pill(h.state, h.state === 'active' ? 'ok' : h.state === 'pending' ? 'info' : h.state === 'rejected' ? 'danger' : ''), esc(h.requestedBy) + '<div class="muted" style="font-size:12px">' + esc(h.createdAt) + '</div>', esc(h.approver) + (h.decidedAt ? '<div class="muted" style="font-size:12px">' + esc(h.decidedAt) + '</div>' : '<div class="muted" style="font-size:12px">waiting</div>'),
      h.state === 'pending' && h.requestedBy === ME ? UI.btn('Withdraw', { size: 'xs', kind: 'ghost', attrs: 'data-holdwithdraw="' + h.id + '"' }) : h.state === 'pending' ? UI.btn('Approve', { size: 'xs', attrs: 'data-holddecide="' + h.id + ':approved"' }) + ' ' + UI.btn('Reject', { size: 'xs', kind: 'ghost', attrs: 'data-holddecide="' + h.id + ':rejected"' }) : h.state === 'active' ? UI.btn('Release', { size: 'xs', kind: 'ghost', attrs: 'data-holdrelease="' + h.id + '"' }) : ''], attrs: 'data-row="' + h.id + '"' }));
    const holds = UI.panel('Legal holds', UI.notice('A hold on a user or a workspace suspends every retention purge of their conversations, memories and files until it is released. It is placed under dual control: you ask and name another compliance manager, who approves; nothing is suspended until then. The people concerned are not told. Audited legal_hold.requested, approved, rejected, withdrawn and released.', 'info')
      + (st.holdSelf ? UI.problem('Dual control', 'You cannot approve your own request. Name another compliance manager: ' + APPROVERS.join(' or ') + '.', 'tr_7f3e') : '')
      + UI.table(['Subject', 'Reason', 'State', 'Requested by', 'Approver', { label: '', right: true }], holdRows, { clickable: false, minWidth: '900px', emptyTitle: 'No holds', emptyText: 'Retention runs as configured for everyone.' })
      + '<div class="hstack gap6 wrap">' + UI.btn('Request a hold', { kind: 'primary', size: 'sm', icon: 'plus', attrs: 'data-holdnew' }) + '</div>');

    const cxRows = st.cexports.map((x) => ({ cells: ['<span class="mono">' + esc(x.id) + '</span>', esc(x.scope), UI.pill(x.state, x.state === 'ready' ? 'ok' : x.state === 'failed' ? 'danger' : 'info'), UI.label(x.label, { sm: true }), esc(x.counts || (x.error ? x.error : '')) + (x.omitted ? '<div class="muted" style="font-size:12px">' + x.omitted + ' above the requester\'s clearance left out</div>' : ''), esc(x.by) + '<div class="muted" style="font-size:12px">' + esc(x.createdAt) + '</div>', x.state === 'ready' ? UI.btn('Download', { size: 'xs', icon: 'download', attrs: 'data-cxdl="' + x.id + '"' }) : ''], attrs: 'data-row="' + x.id + '"' }));
    const cexports = UI.panel('Compliance exports (eDiscovery)', UI.notice('An export writes the conversations (with their messages), files (metadata and versions), memories, agent runs and accounts of one user or one workspace over a date range as JSON Lines, sealed in the blob store. It needs <span class="mono">compliance:export</span>: a person, or an API key scoped to it that an eDiscovery tool holds (Settings, API keys). Rows above the requester\'s clearance are left out and counted; only someone cleared for the export\'s label downloads it. Every request, run and download is audited.', 'info')
      + (st.cxBlocked ? UI.problem('Above your clearance', 'This export holds restricted content; your clearance is confidential. Ask someone cleared for restricted to download it, or export confidential and below.', 'tr_2a91') : '')
      + UI.table(['Export', 'Scope', 'State', 'Label', 'Contents', 'Requested by', { label: '', right: true }], cxRows, { clickable: false, minWidth: '960px', emptyTitle: 'No exports', emptyText: 'Request one for a user or a workspace and a date range.' })
      + '<div class="hstack gap6 wrap">' + UI.btn('Request an export', { kind: 'primary', size: 'sm', icon: 'plus', attrs: 'data-cxnew' }) + '</div>');
    return dlp + holds + cexports;
  }

  function dlpRuleModal(ctx, st, rule) {
    const r = rule ? JSON.parse(JSON.stringify(rule)) : { name: '', enabled: true, detectors: ['payment_card'], raiseTo: 'confidential', action: 'redact', scopes: ['answer', 'agent', 'upload'] };
    const choices = DETECTORS.map((d) => ({ value: d, label: d.replace(/_/g, ' ') })).concat(st.dlp.patterns.map((p) => ({ value: 'pattern:' + p.id, label: 'pattern ' + p.name })));
    ctx.modal({
      title: rule ? 'Edit ' + esc(rule.name) : 'New DLP rule',
      body: '<div class="formgrid">' + UI.field('Name', UI.input(r.name, { attrs: 'data-rname aria-label="Rule name"' }))
        + UI.field('Detects', '<div class="vstack gap4">' + choices.map((c) => '<label class="hstack gap6" style="font-size:13px"><input type="checkbox" data-rdet="' + esc(c.value) + '"' + (r.detectors.includes(c.value) ? ' checked' : '') + '> ' + esc(c.label) + '</label>').join('') + '</div>', 'Built-in detectors score by checksum where one exists (cards by Luhn, IBANs by mod-97); patterns are your own.')
        + UI.field('Raises the label to', UI.select(['internal', 'confidential', 'restricted'], r.raiseTo, 'data-rraise aria-label="Raise to"'))
        + UI.field('Action', UI.select([{ value: 'label', label: 'label: raise only' }, { value: 'redact', label: 'redact: replace the spans' }, { value: 'hold', label: 'hold: keep for a reviewer' }], r.action, 'data-raction aria-label="Action"'))
        + UI.field('Scopes', '<div class="hstack gap6">' + ['answer', 'agent', 'upload'].map((s) => '<label class="hstack gap4" style="font-size:13px"><input type="checkbox" data-rscope="' + s + '"' + (r.scopes.includes(s) ? ' checked' : '') + '> ' + s + '</label>').join('') + '</div>', 'answer: chat and /v1; agent: run outputs; upload: attachments and files (a hold refuses the upload).')
        + '</div>',
      actions: UI.btn('Cancel', { kind: 'ghost', attrs: 'data-close' }) + UI.btn(rule ? 'Save' : 'Create rule', { kind: 'primary', attrs: 'data-rsave' }),
      onMount(m) {
        m.querySelector('[data-rsave]').addEventListener('click', () => {
          const name = m.querySelector('[data-rname]').value.trim(); if (!name) { ctx.toast('A rule needs a name.', 'warn'); return; }
          const detectors = [...m.querySelectorAll('[data-rdet]:checked')].map((el) => el.dataset.rdet); if (!detectors.length) { ctx.toast('Pick at least one detector.', 'warn'); return; }
          const scopes = [...m.querySelectorAll('[data-rscope]:checked')].map((el) => el.dataset.rscope); if (!scopes.length) { ctx.toast('Pick at least one scope.', 'warn'); return; }
          const next = { id: r.id || 'dlp-' + (st.dlp.rules.length + 1), name, enabled: r.enabled, detectors, raiseTo: m.querySelector('[data-rraise]').value, action: m.querySelector('[data-raction]').value, scopes, hits: r.hits || 0 };
          if (rule) Object.assign(rule, next); else st.dlp.rules.push(next);
          App.closeOverlay(); ctx.rerender(); ctx.toast('DLP rule ' + esc(name) + (rule ? ' saved' : ' created') + '. Audited dlp.rule.' + (rule ? 'updated' : 'created') + '.', 'ok');
        });
      }
    });
  }

  function patternModal(ctx, st) {
    ctx.modal({
      title: 'New pattern',
      body: '<div class="formgrid">' + UI.field('Name', UI.input('', { placeholder: 'Customer numbers', attrs: 'data-pname aria-label="Pattern name"' })) + UI.field('Expression (RE2)', UI.input('', { placeholder: 'NW-C-\\d{6}', attrs: 'data-pexpr aria-label="Expression"' }), 'RE2 refuses backreferences and look-around; the position of the offending construct is reported.') + UI.field('Label it implies', UI.select(['internal', 'confidential', 'restricted'], 'confidential', 'data-plabel aria-label="Label"')) + '</div>',
      actions: UI.btn('Cancel', { kind: 'ghost', attrs: 'data-close' }) + UI.btn('Create pattern', { kind: 'primary', attrs: 'data-psave' }),
      onMount(m) {
        m.querySelector('[data-psave]').addEventListener('click', () => {
          const name = m.querySelector('[data-pname]').value.trim(); const expr = m.querySelector('[data-pexpr]').value.trim();
          if (!name || !expr) { ctx.toast('A pattern needs a name and an expression.', 'warn'); return; }
          if (/\\[1-9]|\(\?[=!<]/.test(expr)) { ctx.toast('<b>Invalid pattern.</b> RE2 rejected it at position ' + (expr.search(/\\[1-9]|\(\?[=!<]/) + 1) + ': backreferences and look-around need backtracking.', 'danger', 6000); return; }
          st.dlp.patterns.push({ id: 'pat-' + (st.dlp.patterns.length + 1), name, pattern: expr, label: m.querySelector('[data-plabel]').value, enabled: true });
          App.closeOverlay(); ctx.rerender(); ctx.toast('Pattern ' + esc(name) + ' created. Audited dlp.pattern.created.', 'ok');
        });
      }
    });
  }

  function holdModal(ctx, st) {
    ctx.modal({
      title: 'Request a legal hold',
      body: UI.notice('Nothing is suspended until the approver, another compliance manager, approves. The people concerned are not told.', 'info')
        + '<div class="formgrid">' + UI.field('On', '<div class="hstack gap6">' + UI.select([{ value: 'user', label: 'A user' }, { value: 'workspace', label: 'A workspace' }], 'user', 'data-hscope aria-label="Scope"') + UI.input('', { placeholder: 'j.lindqvist or Field Sales', attrs: 'data-hsubject aria-label="Subject"' }) + '</div>')
        + UI.field('Reason', UI.textarea('', { placeholder: 'Litigation, regulator request, investigation: the case and what to preserve.', attrs: 'data-hreason aria-label="Reason"', rows: 3 }), 'Sealed with the tenant key; the audit chain keeps an excerpt.')
        + UI.field('Approver', UI.select([{ value: ME, label: ME + ' (you)' }].concat(APPROVERS.map((a) => ({ value: a, label: a }))), APPROVERS[0], 'data-happrover aria-label="Approver"'), 'Another holder of compliance:manage.') + '</div>',
      actions: UI.btn('Cancel', { kind: 'ghost', attrs: 'data-close' }) + UI.btn('Ask for approval', { kind: 'primary', attrs: 'data-hsave' }),
      onMount(m) {
        m.querySelector('[data-hsave]').addEventListener('click', () => {
          const subject = m.querySelector('[data-hsubject]').value.trim(); const reason = m.querySelector('[data-hreason]').value.trim(); const approver = m.querySelector('[data-happrover]').value;
          if (!subject || reason.length < 3) { ctx.toast('Name the subject and give a reason.', 'warn'); return; }
          if (approver === ME) { st.holdSelf = true; App.closeOverlay(); ctx.rerender(); ctx.toast('<b>Dual control.</b> You cannot approve your own request.', 'danger'); return; }
          st.holdSelf = false;
          st.holds.unshift({ id: 'lh-' + (st.holds.length + 1), scope: m.querySelector('[data-hscope]').value, subject, reason, state: 'pending', requestedBy: ME, approver, decidedAt: null, createdAt: '19 Sep 14:20' });
          App.closeOverlay(); ctx.rerender(); ctx.toast('Hold requested; ' + esc(approver) + ' was asked to approve. Audited legal_hold.requested.', 'ok');
        });
      }
    });
  }

  function cexportModal(ctx, st) {
    ctx.modal({
      title: 'Request a compliance export',
      body: '<div class="formgrid">' + UI.field('User', UI.input('', { placeholder: 'j.lindqvist (optional)', attrs: 'data-cxuser aria-label="User"' })) + UI.field('Workspace', UI.select(['', 'Finance Ops', 'People Ops', 'Field Sales'], '', 'data-cxws aria-label="Workspace"'), 'One or both.')
        + UI.field('From', UI.input('2026-01-01', { type: 'date', attrs: 'data-cxfrom aria-label="From"' })) + UI.field('To', UI.input('2026-09-19', { type: 'date', attrs: 'data-cxto aria-label="To"' }))
        + UI.field('Contents', '<div class="hstack gap6 wrap">' + ['conversations', 'files', 'memories', 'runs', 'users'].map((k) => '<label class="hstack gap4" style="font-size:13px"><input type="checkbox" data-cxkind="' + k + '" checked> ' + k + '</label>').join('') + '</div>') + '</div>'
        + UI.notice('Rows above your clearance are left out and counted. An eDiscovery tool requests and downloads the same way with an API key scoped to compliance:export.', 'info'),
      actions: UI.btn('Cancel', { kind: 'ghost', attrs: 'data-close' }) + UI.btn('Request export', { kind: 'primary', attrs: 'data-cxsave' }),
      onMount(m) {
        m.querySelector('[data-cxsave]').addEventListener('click', () => {
          const user = m.querySelector('[data-cxuser]').value.trim(); const ws = m.querySelector('[data-cxws]').value;
          if (!user && !ws) { ctx.toast('Name a user, a workspace, or both.', 'warn'); return; }
          const kinds = [...m.querySelectorAll('[data-cxkind]:checked')].map((el) => el.dataset.cxkind);
          const id = 'cx-' + (st.cexports.length + 1);
          st.cexports.unshift({ id, scope: [user ? 'user ' + user : null, ws ? 'workspace ' + ws : null].filter(Boolean).join(', ') + ', ' + m.querySelector('[data-cxfrom]').value + ' to ' + m.querySelector('[data-cxto]').value + ', ' + kinds.join(' '), state: 'queued', label: 'public', counts: '', omitted: 0, by: ME, createdAt: '19 Sep 14:21' });
          App.closeOverlay(); ctx.rerender(); ctx.toast('Export ' + id + ' queued. Audited compliance.export.requested.', 'ok');
          setTimeout(() => { const x = st.cexports.find((e) => e.id === id); if (!x || x.state !== 'queued') return; x.state = 'ready'; x.label = 'confidential'; x.counts = '12 conversations, 96 messages, 3 files, 4 memories, 1 run, 1 user'; x.omitted = 2; ctx.rerender(); ctx.toast('Export ' + id + ' is ready: 2 rows above your clearance were left out. Audited compliance.exported.', 'ok', 5000); }, 1500);
        });
      }
    });
  }


  // ---------- chart (inline SVG) ----------
  function chart(st) {
    const W = 600, H = 160, L = 40, R = 590, top = 20, base = 130, max = 360;
    const y = (v) => base - (v / max) * (base - top);
    const bw = 22, gap = 38;
    let bars = '';
    TOKENS.forEach((v, i) => {
      const x = 44 + i * gap; const yy = y(v);
      const hi = i === TOKENS.length - 1; const hov = st.hover === i;
      bars += '<g class="ua-bar' + (hov ? ' hov' : '') + '" data-bar="' + i + '" tabindex="0" role="listitem" aria-label="' + DAYS[i] + ', ' + fmt(EXACT[i]) + ' tokens">'
        + '<rect x="' + (x - 8) + '" y="' + top + '" width="' + gap + '" height="' + (base - top) + '" fill="transparent"></rect>'
        + '<path d="M' + x + ' ' + base + ' V' + (yy + 4) + ' a4 4 0 0 1 4 -4 h' + (bw - 8) + ' a4 4 0 0 1 4 4 V' + base + ' z" fill="' + (hi || hov ? 'var(--accent)' : 'var(--meter)') + '"></path>'
        + '<title>' + DAYS[i] + ': ' + fmt(EXACT[i]) + ' tokens</title></g>';
    });
    const hov = st.hover != null ? st.hover : null;
    const tip = hov != null ? '<g><rect x="' + Math.min(R - 120, Math.max(L, 44 + hov * gap - 40)) + '" y="' + Math.max(0, y(TOKENS[hov]) - 34) + '" width="120" height="26" rx="4" fill="var(--fg)"></rect><text x="' + (Math.min(R - 120, Math.max(L, 44 + hov * gap - 40)) + 60) + '" y="' + (Math.max(0, y(TOKENS[hov]) - 34) + 17) + '" text-anchor="middle" font-size="11" font-weight="600" fill="var(--bg)">' + DAYS[hov] + ', ' + fmt(EXACT[hov]) + '</text></g>' : '';
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="160" role="img" aria-label="Tokens per day for Finance Ops, last 14 days, in thousands" style="display:block;font-family:var(--sans)">'
      + '<g stroke="var(--line2)"><line x1="' + L + '" y1="' + top + '" x2="' + R + '" y2="' + top + '"></line><line x1="' + L + '" y1="' + (top + (base - top) / 2) + '" x2="' + R + '" y2="' + (top + (base - top) / 2) + '"></line></g>'
      + '<line x1="' + L + '" y1="' + base + '" x2="' + R + '" y2="' + base + '" stroke="var(--faint)"></line>'
      + '<g role="list">' + bars + '</g>'
      + '<g font-size="11" fill="var(--muted)"><text x="34" y="24" text-anchor="end">360k</text><text x="34" y="79" text-anchor="end">180k</text><text x="34" y="134" text-anchor="end">0</text><text x="44" y="148">6 Sep</text><text x="570" y="148" text-anchor="end">19 Sep</text>'
      + (hov == null ? '<text x="549" y="28" text-anchor="middle" fill="var(--fg)" font-weight="600">310k</text>' : '') + '</g>' + tip + '</svg>';
  }

  App.register({
    id: 'usage-audit', title: 'Usage and audit', section: 'admin', crumb: ['Admin', 'Usage and audit'],
    summary: 'Metering per tenant, user and model, quotas, hash-chained audit log, exports',
    commands: [
      { label: 'Verify the Northwind audit chain', sub: 'Usage and audit', run(app) { app.stateFor('usage-audit').runVerify = true; app.render(); } },
      { label: 'Export audit events as CSV', sub: 'Usage and audit', run(app) { app.stateFor('usage-audit').openExport = true; app.render(); } }
    ],
    states: [
      { title: 'Verification failed', tone: 'danger', text: 'The chain breaks at event 7a201f3d. Shows the last good checkpoint and who was notified. Nothing is auto-repaired.', apply(ctx) { ctx.state.chain = 'broken'; ctx.state.forceBreak = true; ctx.state.tab = 'audit'; ctx.state.sel = '7a201f3d'; ctx.state.inspect = 'event'; ctx.rerender(); } },
      { title: 'Export blocked', tone: 'warn', text: 'The export includes confidential events and the auditor is cleared to internal. Offers a filtered export.', apply(ctx) { ctx.state.exportBlocked = true; ctx.state.openExport = true; ctx.rerender(); } },
      { title: 'Corrections', tone: 'neutral', text: 'A correction is a new row linked to the row it corrects. The original is never edited.', apply(ctx) { ctx.state.tab = 'audit'; ctx.state.sel = '44c1e90a'; ctx.state.inspect = 'event'; ctx.state.showCorrection = true; ctx.rerender(); } },
      { title: 'SIEM destination awaiting approval', tone: 'warn', text: 'A proposed destination sends nothing until a second tenant admin approves it; the proposer cannot.', apply(ctx) { ctx.state.tab = 'exports'; ctx.rerender(); } },
      { title: 'Hold waits for a second manager', tone: 'info', text: 'A legal hold is requested by one compliance manager and approved by another; until then nothing is suspended, and approving one\'s own request is refused (403, step dual-control).', apply(ctx) { ctx.state.tab = 'compliance'; ctx.state.holdSelf = true; ctx.rerender(); } },
      { title: 'DLP held an answer', tone: 'warn', text: 'A hold rule (or a label raised above the owner\'s clearance) keeps the answer for a reviewer in the Flags queue, as a guardrail hold would; the message and its conversation carry the raised label.', apply(ctx) { ctx.state.tab = 'compliance'; ctx.state.dlpTried = 'The deploy key is -----BEGIN OPENSSH PRIVATE KEY----- b3BlbnNzaC1rZXktdjEAAAAABG5vbmU'; ctx.state.dlpScope = 'answer'; ctx.rerender(); } },
      { title: 'Export above clearance', tone: 'danger', text: 'An export that holds rows above the downloader\'s clearance is refused (403, step clearance); rows above the requester\'s clearance were already left out and counted when it was written.', apply(ctx) { ctx.state.tab = 'compliance'; ctx.state.cxBlocked = true; ctx.rerender(); } },
      { title: 'Bar hover', tone: 'neutral', text: 'Hovering a bar shows the day and exact token count. The table view carries the same values.', apply(ctx) { ctx.state.tab = 'usage'; ctx.state.chartTable = false; ctx.state.hover = 10; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      st.tab = st.tab || 'usage'; st.by = st.by || 'user'; st.q = st.q || ''; st.kind = st.kind || 'all'; st.chain = st.chain || 'verified';
      st.sel = st.sel || '9e02a41c'; st.inspect = st.inspect || 'event'; st.exports = st.exports || EXPORTS.slice(); st.period = st.period || '19 Sep';
      st.dlp = st.dlp || JSON.parse(JSON.stringify(DLP0)); st.holds = st.holds || HOLDS0.map((h) => Object.assign({}, h)); st.cexports = st.cexports || CEXPORTS0.map((x) => Object.assign({}, x));
      if (ctx.params.event) { st.sel = ctx.params.event; st.inspect = 'event'; st.tab = 'audit'; }
      if (ctx.params.tab) st.tab = ctx.params.tab;

      const ev = EVENTS.find((e) => e.hash === st.sel) || EVENTS[0];
      const usageRows = USAGE[st.by];
      const events = EVENTS.filter((e) => (st.kind === 'all' || e.kind === st.kind) && (!st.q || (e.actor + ' ' + e.action + ' ' + e.target + ' ' + e.hash + ' ' + e.label).toLowerCase().includes(st.q.toLowerCase())));

      // ----- top row -----
      const chainCard = UI.panel('Audit chain', '<div class="hstack" style="justify-content:space-between"><b>Northwind chain</b>' + (st.chain === 'broken' ? UI.pill('broken at 7a201f3d', 'danger') : st.chain === 'verifying' ? UI.pill('verifying', 'info') : UI.pill('verified', 'ok')) + '</div>'
        + UI.kv([['Last signed checkpoint', st.chain === 'broken' ? '19 Sep 06:00, last good' : '19 Sep 14:00, write-once store'], ['Events today', '4,812'], ['Head hash', '<span class="mono">' + (st.chain === 'broken' ? '7a201f3d' : st.verifiedHead || '9e02a41c') + '</span>'], ['Stream', 'SIEM via exprsn.events']], 2)
        + (st.chain === 'broken' ? UI.notice('<b>Verification failed.</b> Row 7a201f3d does not cover the hash of 5e77ab04. Notified security-oncall and T. Wieczorek at 14:03. Nothing is auto-repaired; the store keeps both rows.', 'danger', UI.btn('Open event', { size: 'sm', attrs: 'data-sel="7a201f3d"' })) : ''), { actions: UI.btn('Verify chain', { size: 'sm', kind: 'ghost', attrs: 'data-verify' }) });

      const chartPanel = UI.panel('Tokens per day, Finance Ops, thousands', st.chartTable
        ? UI.table(['Day', { label: 'Tokens', right: true }, { label: 'Thousands', right: true }], DAYS.map((d, i) => [d, fmt(EXACT[i]), TOKENS[i] + 'k']), { clickable: false, cls: 'bare', minWidth: '0' })
        : '<div class="ua-chart">' + chart(st) + '</div><div class="muted" style="font-size:12px">Prompt and output tokens metered on the final stream chunk. The last bar is today, so far.</div>',
        { actions: UI.btn(st.chartTable ? 'View as chart' : 'View as table', { size: 'sm', kind: 'ghost', attrs: 'data-charttable' }) });

      // ----- tabs -----
      const tabs = UI.tabs([{ id: 'usage', label: 'Usage' }, { id: 'quotas', label: 'Quotas' }, { id: 'audit', label: 'Audit log', count: EVENTS.length }, { id: 'exports', label: 'Exports', count: st.exports.length }, { id: 'compliance', label: 'Compliance', count: st.holds.filter((h) => h.state === 'pending' || h.state === 'active').length }], st.tab);

      let body = '';
      if (st.tab === 'usage') {
        body = '<div class="hstack wrap"><div class="eyebrow">Usage, ' + esc(st.period) + '</div>' + UI.seg([{ id: 'user', label: 'Per user' }, { id: 'model', label: 'Per model' }, { id: 'tenant', label: 'Per tenant' }], st.by, 'data-byseg') + '<span class="right">' + UI.select(['19 Sep', 'Last 7 days', 'Last 30 days', 'September'], st.period, 'data-period style="width:150px"') + '</span></div>'
          + UI.table([st.by === 'user' ? 'User or agent' : st.by === 'model' ? 'Model' : 'Tenant', st.by === 'model' ? 'Pool' : st.by === 'tenant' ? 'Workspaces' : 'Model', { label: 'Prompt tok.', right: true }, { label: 'Output tok.', right: true }, { label: 'GPU-s', right: true }, 'Thinking / doing / calc'],
            usageRows.map((r, i) => ({ cells: ['<b>' + esc(r.who) + '</b>', '<span class="mono">' + esc(r.model) + '</span>', fmt(r.prompt), fmt(r.out), fmt(r.gpu), '<span class="num">' + esc(r.mix) + '</span>'], attrs: 'data-usage="' + i + '"', selected: st.inspect === 'usage' && st.usageSel === i && st.usageBy === st.by })), { minWidth: '640px' })
          + '<div class="muted" style="font-size:12px">Thinking, doing and calc split the output tokens between reasoning, answer text and calculator or tool calls.</div>';
      } else if (st.tab === 'quotas') {
        body = '<div class="eyebrow">Quotas per workspace</div>'
          + (st.quotaHit ? UI.notice('<b>Field Sales reached its token quota at 15:12.</b> Requests return 429 with Retry-After 08:00 tomorrow. A tenant admin can raise the limit.', 'warn', UI.btn('Open tenant', { size: 'sm', attrs: 'data-go="tenants"' })) : '')
          + '<div class="grid2">' + QUOTAS.map((q) => UI.panel(q.scope, UI.meter('Tokens today', q.tokensDay, q.tokensPct, q.tokensPct >= 90 ? 'danger' : q.tokensPct >= 60 ? 'warn' : '') + UI.meter('GPU-seconds, month', q.gpu, q.gpuPct, q.gpuPct >= 90 ? 'warn' : '') + UI.meter('Training GPU-hours', q.train, q.trainPct) + '<div class="muted" style="font-size:12px">Raised by: ' + esc(q.raise) + '. Over quota returns 429 with a reset time.</div>', { actions: UI.btn('Edit limits', { size: 'sm', kind: 'ghost', attrs: 'data-editquota="' + esc(q.scope) + '"' }) })).join('') + '</div>';
      } else if (st.tab === 'compliance') {
        body = renderCompliance(ctx, st);
      } else if (st.tab === 'audit') {
        body = '<div class="hstack wrap"><div class="eyebrow">Audit events</div>' + UI.search('Search actor, action, target or hash', 'data-q', st.q) + '<span class="hstack gap6">' + [['all', 'All'], ['decision', 'Decisions'], ['admin', 'Admin actions'], ['correction', 'Corrections'], ['system', 'System']].map((k) => UI.chip(k[1], st.kind === k[0], 'data-kind="' + k[0] + '"')).join('') + '</span></div>'
          + (st.showCorrection ? UI.notice('<b>Corrections.</b> Row 44c1e90a corrects c81e9f2c. The original row is unchanged and its hash still chains; readers see both.', 'info') : '')
          + UI.table(['Time', 'Actor', 'Action', 'Target', 'Label', 'Hash', ''], events.map((e) => ({
            cells: ['<span class="mono">' + e.time + '</span>', esc(e.actor), '<span class="mono">' + esc(e.action) + '</span>', e.corrects ? 'corrects <a href="#" data-sel="' + e.corrects + '" class="mono">' + e.corrects + '</a>' : esc(e.target), UI.label(e.label, { sm: true }),
              '<span class="mono" style="' + (st.chain === 'broken' && e.hash === '7a201f3d' ? 'color:var(--danger-fg);font-weight:600' : '') + '">' + e.hash + '</span>' + (st.chain === 'broken' && e.hash === '7a201f3d' ? ' ' + UI.pill('break', 'danger') : '') + (st.showCorrection && e.hash === 'c81e9f2c' ? ' ' + UI.pill('corrected', 'outline') : ''),
              UI.btn('JSON', { size: 'xs', kind: 'ghost', attrs: 'data-json="' + e.hash + '"' })],
            attrs: 'data-sel="' + e.hash + '"', selected: st.inspect === 'event' && st.sel === e.hash
          })), { minWidth: '700px', emptyTitle: 'No events match', emptyText: 'Clear the search or pick another kind.' })
          + '<div class="muted" style="font-size:12px">Append-only. Each hash covers the previous row. Corrections are new rows; nothing is edited or deleted.</div>';
      } else {
        body = '<div class="hstack"><div class="eyebrow">Exports</div><span class="right">' + UI.btn('New export', { size: 'sm', icon: 'download', attrs: 'data-export' }) + '</span></div>'
          + UI.table(['File', 'Scope', { label: 'Rows', right: true }, 'Requested by', 'State', ''], st.exports.map((x) => [ '<span class="mono">' + esc(x.file) + '</span>', esc(x.scope), esc(x.rows), esc(x.by), UI.pill(x.state), x.state === 'ready' ? UI.btn('Download', { size: 'xs', kind: 'ghost', attrs: 'data-dl="' + esc(x.file) + '"' }) : '' ]), { clickable: false, minWidth: '640px' })
          + UI.notice('Exports of <b>confidential</b> rows need auditor clearance at that level or above; otherwise the export is filtered to internal and below.', 'info')
          + siemPanel();
      }

      // ----- B-7501: audit streaming per tenant, under dual control -----
      st.siem = st.siem || [
        { id: 's1', name: 'Splunk HEC (SOC)', kind: 'https', url: 'https://hec.soc.northwind.example/services/collector/raw', token: true, state: 'active', by: 'Mara Okafor', approvedBy: 'Tomasz Wieczorek', delivered: '1,204,118', last: '14:02:19', connection: 'connected', error: null },
        { id: 's2', name: 'Sentinel (syslog)', kind: 'syslog', url: 'siem-eu.northwind.example:6514', token: false, state: 'proposed', by: 'Mara Okafor', approvedBy: null, delivered: '0', last: null, connection: 'disabled', error: null },
        { id: 's3', name: 'Old Logstash', kind: 'https', url: 'https://logstash.legacy.example:8443/', token: true, state: 'disabled', by: 'Tomasz Wieczorek', approvedBy: 'Mara Okafor', delivered: '88,301', last: '2 Sep', connection: 'disabled', error: 'SIEM answered 503' }
      ];
      function siemPanel() {
        return '<div class="hstack" style="margin-top:12px"><div class="eyebrow">Streaming to a SIEM</div><span class="right">' + UI.btn('Propose destination', { size: 'sm', icon: 'plus', attrs: 'data-siempropose' }) + '</span></div>'
          + UI.table(['Destination', 'Kind', 'Address', 'State', { label: 'Delivered', right: true }, 'Last', ''], st.siem.map((d) => ({ cells: ['<b>' + esc(d.name) + '</b>' + (d.token ? '<div class="muted" style="font-size:11px">bearer token sealed</div>' : ''), esc(d.kind === 'https' ? 'HTTPS, NDJSON' : 'syslog over TLS'), '<span class="mono" style="overflow-wrap:anywhere">' + esc(d.url) + '</span>',
              UI.pill(d.state === 'proposed' ? 'awaits a second admin' : d.state, d.state === 'active' ? 'ok' : d.state === 'proposed' ? 'warn' : 'neutral') + (d.state === 'active' ? ' ' + UI.pill(d.connection, d.connection === 'connected' ? 'ok' : d.connection === 'failing' ? 'danger' : 'neutral') : ''),
              esc(d.delivered), esc(d.last || '-') + (d.error ? '<div class="muted" style="font-size:11px">' + esc(d.error) + '</div>' : ''),
              '<span class="hstack gap6" style="justify-content:flex-end">' + (d.state === 'proposed' ? UI.btn('Approve', { size: 'xs', kind: 'primary', attrs: 'data-siemapprove="' + d.id + '"' }) + UI.btn('Reject', { size: 'xs', kind: 'ghost', attrs: 'data-siemreject="' + d.id + '"' }) : '') + (d.state !== 'rejected' ? UI.btn('Test', { size: 'xs', kind: 'ghost', attrs: 'data-siemtest="' + d.id + '"' }) : '') + (d.state === 'active' ? UI.btn('Disable', { size: 'xs', kind: 'ghost', attrs: 'data-siemdisable="' + d.id + '"' }) : '') + '</span>'],
            attrs: 'data-siemrow="' + d.id + '"' })), { clickable: false, minWidth: '720px', emptyTitle: 'No destinations', emptyText: 'Propose an HTTPS or syslog-over-TLS destination; a second tenant admin approves it before anything is sent.' })
          + UI.notice('<b>Dual control.</b> A destination streams this tenant\'s audit events only after a second tenant admin approves it. The proposer cannot approve. Tokens are sealed and never shown again; every decision and test is on the chain. The platform stream (SIEM_URL) stays the operator\'s.', 'info');
      }
      function siemProposeModal() {
        ctx.modal({
          title: 'Propose a SIEM destination',
          body: '<div class="formgrid">' + UI.field('Name', UI.input('Sentinel (syslog)', { attrs: 'data-sname' })) + UI.field('Kind', UI.select(['HTTPS, NDJSON batches', 'syslog over TLS (RFC 5424)'], 'syslog over TLS (RFC 5424)', 'data-skind')) + UI.field('Address', UI.input('siem-eu.northwind.example:6514', { attrs: 'data-surl' }), 'https://host/path, or host:port for syslog. Cloud metadata and unlisted internal addresses are refused.') + UI.field('Bearer token', UI.input('', { type: 'password', attrs: 'data-stoken', placeholder: 'HTTPS only; sealed, shown once' })) + UI.field('Private CA (PEM)', UI.textarea('', { attrs: 'data-sca', placeholder: 'Optional: the CA that signed the receiver\'s certificate' })) + '</div>'
            + UI.notice('Nothing is sent until another tenant admin approves. Audited audit.siem.proposed.', 'info'),
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Propose', { kind: 'primary', attrs: 'data-sgo' }),
          onMount(m) { m.querySelector('[data-sgo]').addEventListener('click', () => { st.siem.unshift({ id: 's' + Date.now(), name: m.querySelector('[data-sname]').value || 'New destination', kind: /HTTPS/.test(m.querySelector('[data-skind]').value) ? 'https' : 'syslog', url: m.querySelector('[data-surl]').value, token: !!m.querySelector('[data-stoken]').value, state: 'proposed', by: 'Mara Okafor', approvedBy: null, delivered: '0', last: null, connection: 'disabled', error: null }); App.closeOverlay(); st.tab = 'exports'; ctx.rerender(); ctx.toast('Proposed. A second tenant admin can approve it now. Audited audit.siem.proposed.', 'ok'); }); }
        });
      }

      // ----- inspector -----
      let insp = '';
      if (st.inspect === 'usage' && st.usageBy === st.by && USAGE[st.by][st.usageSel]) {
        const r = USAGE[st.by][st.usageSel];
        insp = '<div class="eyebrow">' + esc(r.kind) + '</div><div style="font-size:15px;font-weight:600">' + esc(r.who) + '</div>'
          + UI.kv([['Prompt tokens', fmt(r.prompt)], ['Output tokens', fmt(r.out)], ['GPU-seconds', fmt(r.gpu)], ['Thinking / doing / calc', r.mix], [st.by === 'model' ? 'Pool' : 'Model', '<span class="mono">' + esc(r.full || r.model) + '</span>'], ['Period', esc(st.period)]], 2)
          + '<div class="vstack gap6">' + (r.full && st.by !== 'tenant' ? UI.btn('Open model', { size: 'sm', attrs: 'data-go="models"' }) : '') + (r.convo ? UI.btn('Open last conversation', { size: 'sm', attrs: 'data-convo="' + r.convo + '"' }) : '') + (st.by === 'tenant' ? UI.btn('Open tenant', { size: 'sm', attrs: 'data-go="tenants"' }) : UI.btn('Open pool', { size: 'sm', kind: 'ghost', attrs: 'data-go="pools"' })) + '</div>';
      } else {
        insp = '<div class="eyebrow">Event ' + ev.hash + '</div>'
          + UI.kv([['Action', '<span class="mono">' + esc(ev.action) + '</span>'], ['Actor', esc(ev.actorFull)], ['Target', esc(ev.target)], ['Label', UI.label(ev.label, { sm: true })], ['Decision', esc(ev.decision)], ['Previous hash', '<span class="mono">' + ev.prev + '</span>'], ['Trace', '<span class="mono">' + ev.trace.slice(0, 16) + '</span> ' + UI.btn('Copy', { kind: 'ghost', size: 'xs', attrs: 'data-copy="' + ev.trace + '"' })]].concat(ev.corrects ? [['Corrects', '<a href="#" data-sel="' + ev.corrects + '" class="mono">' + ev.corrects + '</a>']] : []), 1)
          + (st.chain === 'broken' && ev.hash === '7a201f3d' ? UI.notice('This row is where verification stopped. Its hash does not cover 5e77ab04.', 'danger') : '')
          + '<div class="vstack gap6">' + UI.btn('Open full event', { size: 'sm', icon: 'eye', attrs: 'data-json="' + ev.hash + '"' }) + (ev.convo ? UI.btn('Open conversation', { size: 'sm', attrs: 'data-convo="' + ev.convo + '"' }) : '') + (ev.action === 'user.disabled' ? UI.btn('Open tenant members', { size: 'sm', attrs: 'data-go="tenants"' }) : '') + (ev.action === 'zone.check.passed' ? UI.btn('Open zones', { size: 'sm', attrs: 'data-go="zones"' }) : '') + (ev.action === 'guardrail.rule.updated' ? UI.btn('Open guardrails', { size: 'sm', attrs: 'data-go="guardrails"' }) : '') + '</div>';
      }
      insp += '<div class="divider"></div><div class="eyebrow">Quota, Finance Ops</div>' + UI.meter('Tokens today', '3.1M of 5M', 62) + UI.meter('GPU-seconds this month', '16,380 of 18,000', 91, 'warn') + UI.meter('Training GPU-hours', '136 of 200', 68);

      root.innerHTML = '<style>.main > .page > .tablewrap,.main > .page > .panel,.main > .page > .notice{flex-shrink:0}'
        + '.ua-chart svg .ua-bar{cursor:pointer}.ua-chart svg .ua-bar:hover path,.ua-chart svg .ua-bar:focus path{fill:var(--accent)}.ua-chart svg .ua-bar:focus{outline:none}'
        + '.ua-top{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:14px}@media (max-width:1100px){.ua-top{grid-template-columns:1fr}}'
        + '</style>'
        + '<div class="page">' + UI.pagehead('Usage and audit', 'Metering per tenant, user, model and agent; a hash-chained audit log per tenant', UI.btn('Export CSV', { icon: 'download', attrs: 'data-export' }) + UI.btn('Verify chain', { kind: 'primary', attrs: 'data-verify' }))
        + '<div class="ua-top">' + chartPanel + chainCard + '</div>'
        + tabs + body
        + '</div>'
        + '<aside class="inspector w300">' + insp + '</aside>';

      // ----- deferred actions from commands / states -----
      if (st.runVerify) { st.runVerify = false; setTimeout(() => verify(), 50); }
      if (st.openExport) { st.openExport = false; setTimeout(() => exportModal(), 50); }

      // ----- handlers -----
      function verify() {
        ctx.confirm({ title: 'Verify the Northwind chain', tag: 'read only', tone: 'info', body: '<p style="margin:0" class="fg2">Recomputes every hash from the last signed checkpoint to the head and compares it with the write-once store. Nothing is changed.</p>', kv: [['Events since checkpoint', '4,812'], ['Checkpoint', '19 Sep 14:00']], ok: 'Verify' }).then((ok) => {
          if (!ok) return;
          st.chain = 'verifying'; ctx.rerender();
          setTimeout(() => {
            if (st.forceBreak) { st.chain = 'broken'; ctx.rerender(); ctx.toast('<b>Verification failed</b> at 7a201f3d. security-oncall notified.', 'danger', 6000); return; }
            st.chain = 'verified'; st.verifiedHead = '9e02a41c'; ctx.rerender(); ctx.toast('Northwind chain verified: 4,812 events, head 9e02a41c matches the checkpoint.', 'ok');
          }, 1400);
        });
      }
      function exportModal() {
        const blocked = !!st.exportBlocked;
        ctx.modal({
          title: 'Export CSV',
          body: '<div class="formgrid">' + UI.field('Content', UI.select(['Audit events', 'Audit events as JSONL with chain proof', 'Usage per user and model', 'Usage per tenant'], st.tab === 'usage' || st.tab === 'quotas' ? 'Usage per user and model' : 'Audit events', 'data-xcontent'), 'JSONL carries every event of the window with its hashes and a checkpoint signed at the window\'s end; it verifies offline with exprsn-ai audit:verify-export. Rows above your clearance are redacted to their hashes.') + UI.field('Scope', UI.select(['Finance Ops', 'Northwind, all workspaces', 'All tenants'], 'Finance Ops')) + UI.field('From', UI.input('2026-09-12', { type: 'date' })) + UI.field('To', UI.input('2026-09-19', { type: 'date' })) + '</div>'
            + (blocked ? UI.notice('<b>Export blocked.</b> The selection includes 212 confidential events and your auditor clearance is internal. You can export internal and below, or ask a tenant admin for a cleared export.', 'warn') : UI.notice('212 of 4,812 rows are labelled confidential. A warning is logged with the export.', 'info')),
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + (blocked ? UI.btn('Export internal and below', { kind: 'primary', attrs: 'data-xfiltered' }) : UI.btn('Export', { kind: 'primary', attrs: 'data-xgo' })),
          onMount(m) {
            const add = (filtered) => {
              const jsonl = /JSONL/.test(m.querySelector('[data-xcontent]').value);
              App.closeOverlay();
              if (jsonl) st.exports.unshift({ file: 'audit-finance-ops-2026-09-19.jsonl', scope: 'Audit JSONL with chain proof, 12 to 19 Sep, checkpoint signed at sequence 4,812' + (filtered ? ', 212 above internal redacted' : ''), rows: '4,812', by: 'Mara Okafor', state: 'ready' });
              else st.exports.unshift({ file: 'audit-finance-ops-2026-09-19' + (filtered ? '-internal' : '') + '.csv', scope: 'Finance Ops, 12 to 19 Sep, ' + (filtered ? 'internal and below' : 'all labels'), rows: filtered ? '4,600' : '4,812', by: 'Mara Okafor', state: 'ready' });
              st.tab = 'exports'; st.exportBlocked = false; ctx.rerender();
              ctx.toast(jsonl ? 'JSONL export ready: 4,812 events, proof at sequence 4,812. Verify it offline with exprsn-ai audit:verify-export.' : filtered ? 'Filtered export ready: 4,600 rows, confidential rows omitted.' : 'Export ready: 4,812 rows. Logged to audit.', 'ok');
            };
            const g = m.querySelector('[data-xgo]'); if (g) g.addEventListener('click', () => add(false));
            const f = m.querySelector('[data-xfiltered]'); if (f) f.addEventListener('click', () => add(true));
          }
        });
      }
      function jsonDrawer(hash) {
        const e = EVENTS.find((x) => x.hash === hash); if (!e) return;
        ctx.drawer({ title: 'Event ' + e.hash + ' ' + UI.label(e.label, { sm: true }), body: '<div class="fg2" style="font-size:12px">Stored row from audit_event. The hash covers every field below including prev_hash.</div>' + UI.code(JSON.stringify(e.json, null, 2), 'json'), actions: UI.btn('Copy JSON', { attrs: 'data-copy="' + e.hash + ' json"' }) + UI.btn('Copy trace ID', { kind: 'ghost', attrs: 'data-copy="' + e.trace + '"' }) + UI.btn('Close', { kind: 'ghost', attrs: 'data-close' }), onMount(d) { d.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => ctx.toast('Copied ' + esc(b.dataset.copy)))); } });
      }

      ctx.on('click', '[data-tab]', (e, t) => { st.tab = t.dataset.tab; ctx.rerender(); });
      // ----- compliance (1.6.0, Sprint 38c) -----
      ctx.on('click', '[data-dlpnew]', () => dlpRuleModal(ctx, st, null));
      ctx.on('click', '[data-dlpedit]', (e, t) => dlpRuleModal(ctx, st, st.dlp.rules.find((r) => r.id === t.dataset.dlpedit)));
      ctx.on('click', '[data-dlptoggle]', (e, t) => { const r = st.dlp.rules.find((x) => x.id === t.dataset.dlptoggle); r.enabled = !r.enabled; ctx.rerender(); ctx.toast('Rule ' + esc(r.name) + (r.enabled ? ' enabled' : ' turned off') + '. Audited dlp.rule.updated.', 'ok'); });
      ctx.on('click', '[data-patnew]', () => patternModal(ctx, st));
      ctx.on('click', '[data-patdel]', async (e, t) => { const p = st.dlp.patterns.find((x) => x.id === t.dataset.patdel); const used = st.dlp.rules.filter((r) => r.detectors.includes('pattern:' + p.id)); if (used.length) { ctx.toast('<b>Pattern in use.</b> ' + esc(used.map((r) => r.name).join(', ')) + ' detects with it; change the rule first.', 'danger', 5000); return; } const ok = await ctx.confirm({ title: 'Remove ' + esc(p.name), tone: 'danger', body: '<p class="fg2" style="margin:0">Audited dlp.pattern.deleted.</p>', ok: 'Remove' }); if (!ok) return; st.dlp.patterns = st.dlp.patterns.filter((x) => x.id !== p.id); ctx.rerender(); ctx.toast('Pattern removed.', 'ok'); });
      ctx.on('click', '[data-dlptry]', () => { st.dlpTried = (ctx.$('[data-dlptext]') || {}).value || ''; st.dlpScope = (ctx.$('[data-dlpscope]') || {}).value || 'answer'; ctx.rerender(); });
      ctx.on('click', '[data-holdnew]', () => holdModal(ctx, st));
      ctx.on('click', '[data-holddecide]', async (e, t) => { const [id, decision] = t.dataset.holddecide.split(':'); const h = st.holds.find((x) => x.id === id); if (h.requestedBy === ME) { st.holdSelf = true; ctx.rerender(); ctx.toast('<b>Dual control.</b> You cannot approve your own request.', 'danger'); return; } const ok = await ctx.confirm({ title: (decision === 'approved' ? 'Approve' : 'Reject') + ' the hold on ' + esc(h.subject), tone: decision === 'approved' ? 'info' : 'danger', body: '<p class="fg2" style="margin:0">' + (decision === 'approved' ? 'Every retention purge of their conversations, memories and files is suspended at once.' : 'The request ends; the requester is told.') + ' Audited legal_hold.' + decision + '.</p>', ok: decision === 'approved' ? 'Approve' : 'Reject' }); if (!ok) return; h.state = decision === 'approved' ? 'active' : 'rejected'; h.decidedAt = '19 Sep 14:22'; st.holdSelf = false; ctx.rerender(); ctx.toast('Hold ' + h.state + '.', 'ok'); });
      ctx.on('click', '[data-holdwithdraw]', (e, t) => { const h = st.holds.find((x) => x.id === t.dataset.holdwithdraw); h.state = 'withdrawn'; ctx.rerender(); ctx.toast('Request withdrawn. Audited legal_hold.withdrawn.', 'ok'); });
      ctx.on('click', '[data-holdrelease]', async (e, t) => { const h = st.holds.find((x) => x.id === t.dataset.holdrelease); const ok = await ctx.confirm({ title: 'Release the hold on ' + esc(h.subject), tone: 'danger', body: '<p class="fg2" style="margin:0">The next retention purge treats their content as before. Audited legal_hold.released.</p>', ok: 'Release' }); if (!ok) return; h.state = 'released'; h.releasedAt = '19 Sep 14:23'; ctx.rerender(); ctx.toast('Hold released.', 'ok'); });
      ctx.on('click', '[data-cxnew]', () => cexportModal(ctx, st));
      ctx.on('click', '[data-cxdl]', (e, t) => { const x = st.cexports.find((e2) => e2.id === t.dataset.cxdl); if (x.label === 'restricted') { st.cxBlocked = true; ctx.rerender(); ctx.toast('<b>Above your clearance.</b> The export holds restricted content.', 'danger'); return; } st.cxBlocked = false; ctx.toast('Downloading ' + esc(x.id) + '.jsonl. Audited compliance.export.downloaded.'); });
      ctx.on('click', '[data-byseg] [data-seg]', (e, t) => { st.by = t.dataset.seg; ctx.rerender(); });
      ctx.on('change', '[data-period]', (e, t) => { st.period = t.value; ctx.rerender(); ctx.toast('Usage recomputed for ' + esc(t.value) + '.'); });
      ctx.on('click', '[data-charttable]', () => { st.chartTable = !st.chartTable; st.hover = null; ctx.rerender(); });
      ctx.on('mouseover', '.ua-bar', (e, t) => { const i = +t.dataset.bar; if (st.hover !== i) { st.hover = i; ctx.rerender(); } });
      ctx.on('mouseout', '.ua-chart', (e, t) => { if (st.hover != null && !(e.relatedTarget && t.contains(e.relatedTarget))) { st.hover = null; ctx.rerender(); } });
      ctx.on('focusin', '.ua-bar', (e, t) => { const i = +t.dataset.bar; if (st.hover !== i) { st.hover = i; ctx.rerender(); const b = ctx.$('.ua-bar[data-bar="' + i + '"]'); if (b) b.focus(); } });
      ctx.on('click', 'tr[data-usage]', (e, t) => { st.inspect = 'usage'; st.usageSel = +t.dataset.usage; st.usageBy = st.by; ctx.rerender(); });
      ctx.on('click', '[data-sel]', (e, t) => { e.preventDefault(); e.stopPropagation(); if (e.target.closest('[data-json]')) return; st.sel = t.dataset.sel; st.inspect = 'event'; st.tab = 'audit'; ctx.rerender(); });
      ctx.on('click', '[data-json]', (e, t) => { e.stopPropagation(); st.sel = t.dataset.json; st.inspect = 'event'; ctx.rerender(); jsonDrawer(t.dataset.json); });
      ctx.on('input', '[data-q]', (e, t) => { st.q = t.value; const v = t.value; ctx.rerender(); const i = ctx.$('[data-q]'); if (i) { i.focus(); i.setSelectionRange(v.length, v.length); } });
      ctx.on('click', '[data-kind]', (e, t) => { st.kind = t.dataset.kind; ctx.rerender(); });
      ctx.on('click', '[data-verify]', () => verify());
      ctx.on('click', '[data-export]', () => exportModal());
      ctx.on('click', '[data-dl]', (e, t) => ctx.toast('Downloading ' + esc(t.dataset.dl) + '. The download is logged to audit.'));
      ctx.on('click', '[data-siempropose]', () => siemProposeModal());
      ctx.on('click', '[data-siemapprove]', (e, t) => {
        const d = st.siem.find((x) => x.id === t.dataset.siemapprove); if (!d) return;
        if (d.by === 'Mara Okafor' && !st.secondAdmin) { ctx.toast('<b>Dual control.</b> You proposed this destination; another tenant admin must approve it.', 'danger', 5000); st.secondAdmin = true; return; }
        d.state = 'active'; d.approvedBy = 'Tomasz Wieczorek'; d.connection = 'connected'; d.last = 'just now'; d.delivered = '1'; ctx.rerender(); ctx.toast('Approved by a second admin: the approval itself is the first event delivered. Audited audit.siem.approved.', 'ok');
      });
      ctx.on('click', '[data-siemreject]', (e, t) => { const d = st.siem.find((x) => x.id === t.dataset.siemreject); if (d) { d.state = 'rejected'; ctx.rerender(); ctx.toast('Rejected. Audited audit.siem.rejected.'); } });
      ctx.on('click', '[data-siemdisable]', (e, t) => { const d = st.siem.find((x) => x.id === t.dataset.siemdisable); if (d) { d.state = 'disabled'; d.connection = 'disabled'; ctx.rerender(); ctx.toast('Disabled: nothing more is sent. Audited audit.siem.disabled.'); } });
      ctx.on('click', '[data-siemtest]', (e, t) => { const d = st.siem.find((x) => x.id === t.dataset.siemtest); if (!d) return; if (d.error) { ctx.toast('Test failed: ' + esc(d.error) + '. Audited audit.siem.tested.', 'danger'); } else { d.last = 'just now'; ctx.rerender(); ctx.toast('Test event delivered to ' + esc(d.name) + '. Audited audit.siem.tested.', 'ok'); } });
      ctx.on('click', '[data-go]', (e, t) => ctx.navigate(t.dataset.go));
      ctx.on('click', '[data-convo]', (e, t) => ctx.navigate('chat', { convo: t.dataset.convo }));
      ctx.on('click', '[data-editquota]', (e, t) => {
        ctx.modal({ title: 'Edit limits, ' + esc(t.dataset.editquota), body: '<div class="formgrid">' + UI.field('Tokens per day', UI.input('5,000,000')) + UI.field('GPU-seconds per month', UI.input('18,000')) + UI.field('Training GPU-hours', UI.input('200')) + UI.field('Over quota', UI.select(['Return 429 with Retry-After', 'Fall back to fast profile', 'Allow with warning'], 'Return 429 with Retry-After')) + '</div>' + UI.notice('Changes take effect on the next request and are written to the audit chain.', 'info'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save limits', { kind: 'primary', attrs: 'data-savequota' }), onMount(m) { m.querySelector('[data-savequota]').addEventListener('click', () => { App.closeOverlay(); ctx.toast('Limits saved for ' + esc(t.dataset.editquota) + '. Audit event written.', 'ok'); }); } });
      });
    }
  });
})();
