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
      { title: 'Bar hover', tone: 'neutral', text: 'Hovering a bar shows the day and exact token count. The table view carries the same values.', apply(ctx) { ctx.state.tab = 'usage'; ctx.state.chartTable = false; ctx.state.hover = 10; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      st.tab = st.tab || 'usage'; st.by = st.by || 'user'; st.q = st.q || ''; st.kind = st.kind || 'all'; st.chain = st.chain || 'verified';
      st.sel = st.sel || '9e02a41c'; st.inspect = st.inspect || 'event'; st.exports = st.exports || EXPORTS.slice(); st.period = st.period || '19 Sep';
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
      const tabs = UI.tabs([{ id: 'usage', label: 'Usage' }, { id: 'quotas', label: 'Quotas' }, { id: 'audit', label: 'Audit log', count: EVENTS.length }, { id: 'exports', label: 'Exports', count: st.exports.length }], st.tab);

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
          + UI.notice('Exports of <b>confidential</b> rows need auditor clearance at that level or above; otherwise the export is filtered to internal and below.', 'info');
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
        + '<div><div class="eyebrow" style="margin-bottom:8px">States to design from this page</div>' + UI.states(this.states) + '</div></div>'
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
          body: '<div class="formgrid">' + UI.field('Content', UI.select(['Audit events', 'Usage per user and model', 'Usage per tenant'], st.tab === 'usage' || st.tab === 'quotas' ? 'Usage per user and model' : 'Audit events', 'data-xcontent')) + UI.field('Scope', UI.select(['Finance Ops', 'Northwind, all workspaces', 'All tenants'], 'Finance Ops')) + UI.field('From', UI.input('2026-09-12', { type: 'date' })) + UI.field('To', UI.input('2026-09-19', { type: 'date' })) + '</div>'
            + (blocked ? UI.notice('<b>Export blocked.</b> The selection includes 212 confidential events and your auditor clearance is internal. You can export internal and below, or ask a tenant admin for a cleared export.', 'warn') : UI.notice('212 of 4,812 rows are labelled confidential. A warning is logged with the export.', 'info')),
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + (blocked ? UI.btn('Export internal and below', { kind: 'primary', attrs: 'data-xfiltered' }) : UI.btn('Export', { kind: 'primary', attrs: 'data-xgo' })),
          onMount(m) {
            const add = (filtered) => { App.closeOverlay(); st.exports.unshift({ file: 'audit-finance-ops-2026-09-19' + (filtered ? '-internal' : '') + '.csv', scope: 'Finance Ops, 12 to 19 Sep, ' + (filtered ? 'internal and below' : 'all labels'), rows: filtered ? '4,600' : '4,812', by: 'Mara Okafor', state: 'ready' }); st.tab = 'exports'; st.exportBlocked = false; ctx.rerender(); ctx.toast(filtered ? 'Filtered export ready: 4,600 rows, confidential rows omitted.' : 'Export ready: 4,812 rows. Logged to audit.', 'ok'); };
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
      ctx.on('click', '[data-go]', (e, t) => ctx.navigate(t.dataset.go));
      ctx.on('click', '[data-convo]', (e, t) => ctx.navigate('chat', { convo: t.dataset.convo }));
      ctx.on('click', '[data-editquota]', (e, t) => {
        ctx.modal({ title: 'Edit limits, ' + esc(t.dataset.editquota), body: '<div class="formgrid">' + UI.field('Tokens per day', UI.input('5,000,000')) + UI.field('GPU-seconds per month', UI.input('18,000')) + UI.field('Training GPU-hours', UI.input('200')) + UI.field('Over quota', UI.select(['Return 429 with Retry-After', 'Fall back to fast profile', 'Allow with warning'], 'Return 429 with Retry-After')) + '</div>' + UI.notice('Changes take effect on the next request and are written to the audit chain.', 'info'), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save limits', { kind: 'primary', attrs: 'data-savequota' }), onMount(m) { m.querySelector('[data-savequota]').addEventListener('click', () => { App.closeOverlay(); ctx.toast('Limits saved for ' + esc(t.dataset.editquota) + '. Audit event written.', 'ok'); }); } });
      });
      ctx.on('click', '.state-card', (e, t) => ctx.app.applyState(+t.dataset.state));
    }
  });
})();
