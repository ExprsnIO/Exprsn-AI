(function () {
  const { UI, esc } = App;

  // Profiles a Finance Ops member may compare. zoneCeiling is the ceiling of the zone the profile's pool runs in.
  const PROFILES = [
    { id: 'chat-default', model: 'llama3.1:8b-q5_K_M', zone: 'core', zoneCeiling: 'confidential', ft: 0.42, tps: 61.3, tokens: 188, gpu: 1.4,
      text: 'The clause limits liability to fees paid in the prior twelve months and excludes indirect loss. It does not cap liability for data breaches, which sit under clause 14.3.' },
    { id: 'analyst', model: 'qwen2.5:32b-q4_K_M', zone: 'core', zoneCeiling: 'confidential', ft: 1.18, tps: 24.7, tokens: 231, gpu: 3.1,
      text: 'The clause limits liability to fees paid in the prior twelve months and excludes indirect loss. It does not cap liability for data breaches, which sit under clause 14.3. Compare with the cap in the 2024 master agreement, which was lower.' },
    { id: 'fast', model: 'llama3.2:3b-q8_0', zone: 'core', zoneCeiling: 'confidential', ft: 0.21, tps: 112.0, tokens: 96, gpu: 0.4,
      text: 'Liability is capped at twelve months of fees. Indirect loss is excluded.' },
    { id: 'legal-review', model: 'mistral-small:24b', zone: 'lab', zoneCeiling: 'internal', ft: 0.97, tps: 29.4, tokens: 64, gpu: 1.2,
      stopped: 'Stopped by rule PII-IBAN at the output checkpoint. Other columns are unaffected.',
      text: 'The clause caps liability at twelve months of fees and excludes indirect loss. Payments under the cap go to the supplier account NL91 ABNA 0417 1643 00 named in schedule 2, and data breaches fall under clause 14.3.' },
    { id: 'coder', model: 'qwen2.5-coder:32b-q4_K_M', zone: 'core', zoneCeiling: 'internal', ft: 1.31, tps: 22.9, tokens: 204, gpu: 2.8,
      text: 'Liability is limited to the fees paid in the twelve months before the claim, and indirect or consequential loss is excluded. Clause 14.3 carries a separate, uncapped obligation for data breaches.' }
  ];
  const LEVEL = { public: 1, internal: 2, confidential: 3, restricted: 4 };
  const byId = (id) => PROFILES.find((p) => p.id === id);
  const available = (p, label) => LEVEL[p.zoneCeiling] >= LEVEL[label];

  function boardResult(p) { return p.stopped ? { done: true, stopped: true, ft: p.ft, tps: p.tps, tokens: p.tokens, partial: '' } : { done: true, ft: p.ft, tps: p.tps, tokens: p.tokens, partial: p.text }; }
  function stopStreams(st) { Object.keys(st.results || {}).forEach((id) => { const r = st.results[id]; if (r && r.timer) { clearTimeout(r.timer); r.timer = null; } }); }
  function fmt(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  function startStream(ctx, st) {
    stopStreams(st);
    st.results = {};
    st.sentCount = (st.sentCount || 0) + 1;
    const active = st.cols.map(byId).filter((p) => available(p, st.label));
    active.forEach((p) => {
      const words = p.text.split(' ');
      const r = st.results[p.id] = { streaming: true, partial: '', n: 0, ft: p.ft, tps: 0, tokens: 0, start: Date.now() };
      const perWord = Math.max(12, Math.round(1000 / (p.tps / 1.3)));
      const step = () => {
        const col = ctx.$('[data-col="' + p.id + '"]');
        if (!col) { r.timer = null; return; }
        r.n++; r.tokens = Math.round(r.n * 1.3); r.partial = words.slice(0, r.n).join(' ');
        const elapsed = (Date.now() - r.start) / 1000;
        r.tps = elapsed > r.ft ? +(r.tokens / (elapsed - r.ft)).toFixed(1) : 0;
        if (p.stopped && r.n >= Math.floor(words.length * 0.55)) { r.streaming = false; r.done = true; r.stopped = true; r.tokens = p.tokens; r.tps = p.tps; r.timer = null; ctx.rerender(); return; }
        if (r.n >= words.length) { r.streaming = false; r.done = true; r.tokens = p.tokens; r.tps = p.tps; r.timer = null; ctx.rerender(); return; }
        const a = col.querySelector('.cmp-answer'); if (a) a.innerHTML = esc(r.partial) + '<span class="blink">▍</span>';
        const t = col.querySelector('[data-m="tps"]'); if (t) t.textContent = r.tps.toFixed(1);
        const k = col.querySelector('[data-m="tokens"]'); if (k) k.textContent = r.tokens;
        r.timer = setTimeout(step, perWord);
      };
      r.timer = setTimeout(step, p.ft * 1000);
    });
    ctx.rerender();
  }

  App.register({
    id: 'compare', title: 'Compare', summary: 'One prompt to two to four profiles, each guardrailed and metered separately',
    crumb: ['Chat', 'Compare'],
    label: (st) => st.label || 'internal',
    commands: [{ label: 'Compare profiles on a prompt', sub: 'Compare', run(app) { app.stateFor('compare').focusPrompt = true; app.render(); } }],
    states: [
      { title: 'Profile unavailable', tone: 'warn', text: 'legal-review is disabled for a confidential conversation: its zone ceiling is internal. Shown disabled with the reason.', apply(ctx) { const st = ctx.state; st.label = 'confidential'; if (!st.cols.includes('legal-review')) { st.cols = st.cols.slice(0, 3).concat('legal-review'); } ctx.rerender(); } },
      { title: 'Two columns', tone: 'neutral', text: 'With two profiles each column widens to the 72 character reading measure.', apply(ctx) { stopStreams(ctx.state); ctx.state.cols = ['chat-default', 'analyst']; ctx.state.results = { 'chat-default': boardResult(byId('chat-default')), analyst: boardResult(byId('analyst')) }; ctx.rerender(); } },
      { title: 'Metered separately', tone: 'neutral', text: 'Each column writes its own usage row. The header shows the combined cost before sending.', apply(ctx) { ctx.state.metered = true; ctx.rerender(); setTimeout(() => { const u = ctx.$('#cmp-usage'); if (u) u.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, 30); } },
      { title: 'Still streaming', tone: 'info', text: 'Metrics show live values and settle when the final chunk arrives.', apply(ctx) { startStream(ctx, ctx.state); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      st.cols = st.cols || ['chat-default', 'analyst', 'fast', 'legal-review'];
      st.label = st.label || 'internal';
      st.prompt = st.prompt == null ? 'Summarise the limitation of liability clause in two sentences.' : st.prompt;
      if (!st.results) { st.results = {}; st.cols.forEach((id) => { st.results[id] = boardResult(byId(id)); }); }
      const cols = st.cols.map(byId);
      const sendable = cols.filter((p) => available(p, st.label));
      const anyStreaming = cols.some((p) => st.results[p.id] && st.results[p.id].streaming);
      const estTokens = sendable.reduce((a, p) => a + p.tokens + 212, 0);
      const estGpu = sendable.reduce((a, p) => a + p.gpu, 0);

      const metric = (k, v, key) => '<div><span class="k">' + esc(k) + '</span><span class="v num" data-m="' + key + '">' + v + '</span></div>';
      const column = (p) => {
        const r = st.results[p.id];
        const ok = available(p, st.label);
        let body = '';
        if (!ok) body = UI.notice('<b>' + esc(p.id) + '</b> is disabled for a ' + esc(st.label) + ' conversation: its zone ceiling is ' + esc(p.zoneCeiling) + '.', 'warn') + '<div class="muted" style="font-size:12px">Zone ' + esc(p.zone) + ' cannot receive ' + esc(st.label) + ' context. Lower the conversation label or pick a profile in zone core.</div>';
        else if (!r) body = '<div class="cmp-answer serif muted">No answer yet. Send the prompt to run this column.</div>';
        else if (r.streaming) body = '<div class="cmp-answer serif">' + esc(r.partial) + '<span class="blink">▍</span></div>';
        else if (r.stopped) body = '<div class="cmp-answer serif muted" style="font-size:13px">' + (r.partial ? esc(r.partial.split(' ').slice(0, 12).join(' ')) + ' …' : 'Answer withheld at the sentence boundary.') + '</div>' + UI.notice(esc(p.stopped), 'danger') + '<div class="hstack gap12" style="font-size:12px"><a href="#" data-rule>View rule</a><a href="#" data-report>Report</a></div>';
        else body = '<div class="cmp-answer serif">' + esc(r.partial) + '</div>';
        const metrics = ok ? '<div class="cmp-metrics">' + metric('First token', r ? r.ft.toFixed(2) + ' s' : '—', 'ft') + metric('Tokens / s', r ? (r.streaming && !r.tps ? '…' : r.tps.toFixed(1)) : '—', 'tps') + metric('Tokens', r ? r.tokens : '—', 'tokens') + '</div>' : '<div class="cmp-metrics muted">' + metric('First token', '—', 'ft') + metric('Tokens / s', '—', 'tps') + metric('Tokens', '—', 'tokens') + '</div>';
        const cont = ok && r && r.done && !r.stopped ? UI.btn('Continue with this one', { attrs: 'data-continue="' + esc(p.id) + '"' }) : ok && r && r.streaming ? UI.btn('Continue with this one', { disabled: true, title: 'Available when the answer settles' }) : ok && r && r.stopped ? UI.btn('Continue with this one', { disabled: true, title: 'Stopped answers cannot start a conversation' }) : ok ? '' : UI.btn('Continue with this one', { disabled: true });
        return '<div class="cmp-col panel' + (ok ? '' : ' off') + '" data-col="' + esc(p.id) + '">'
          + '<div class="hstack" style="align-items:flex-start"><div class="grow" style="min-width:0"><div style="font-size:14px;font-weight:600"><a href="#" data-prof="' + esc(p.id) + '" style="color:inherit;text-decoration:none">' + esc(p.id) + '</a>' + (r && r.streaming ? ' ' + UI.pill('streaming', 'info') : '') + '</div><span class="mono fg2">' + esc(p.model) + '</span></div>' + UI.iconbtn('x', 'Remove column', { cls: 'sm ghost', attrs: 'data-remove="' + esc(p.id) + '"' }) + '</div>'
          + metrics + body + cont + '</div>';
      };

      const usage = st.metered ? '<section class="panel" id="cmp-usage">' + '<div class="phead"><div class="eyebrow">Usage rows for this send</div><span class="muted" style="font-size:12px">One row per column, each with its own guardrail run and label</span></div>'
        + UI.table(['Row', 'Profile', 'Model', 'Tokens', 'GPU-s', 'Guardrail', 'Label'], cols.map((p, i) => { const r = st.results[p.id]; const ok = available(p, st.label); return [ '<span class="mono">u-' + (st.sentCount || 1) + '-' + (i + 1) + '</span>', esc(p.id), '<span class="mono">' + esc(p.model) + '</span>', ok && r ? fmt(r.tokens + 212) : '0', ok && r ? p.gpu.toFixed(1) : '0.0', !ok ? UI.pill('not sent', 'outline') : r && r.stopped ? UI.pill('stopped', 'danger') : r && r.streaming ? UI.pill('running', 'info') : UI.pill('passed', 'ok'), UI.label(st.label, { sm: true }) ]; }), { clickable: false, minWidth: '0' })
        + '<div class="muted" style="font-size:12px">Combined for this send: ' + fmt(sendable.reduce((a, p) => a + ((st.results[p.id] && st.results[p.id].tokens) || 0) + 212, 0)) + ' tokens, ' + estGpu.toFixed(1) + ' GPU-s, ' + sendable.length + ' usage rows. Rows appear under Usage and audit within a minute.</div></section>' : '';

      root.innerHTML = '<style>'
        + '.cmp-page{display:flex;flex-direction:column;gap:14px;padding:18px 22px}'
        + '.cmp-prompt{display:flex;gap:10px;align-items:center}.cmp-prompt input{flex-grow:1;height:34px;font-size:14px}'
        + '.cmp-grid{display:grid;gap:12px;grid-template-columns:repeat(var(--n,4),minmax(0,1fr));align-items:stretch}'
        + '.cmp-col{gap:12px;padding:16px}.cmp-col.off{opacity:.75;background:var(--panel2)}'
        + '.cmp-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;padding:8px 0;border-top:1px solid var(--line2);border-bottom:1px solid var(--line2)}'
        + '.cmp-metrics > div{display:flex;flex-direction:column}.cmp-metrics .k{font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:700}.cmp-metrics .v{font-size:15px;font-weight:600}'
        + '.cmp-answer{font-size:15px;line-height:1.6;flex-grow:1}.cmp-grid[data-n="2"] .cmp-answer{max-width:72ch;font-size:16px}'
        + '.cmp-est{display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-size:12px;color:var(--muted)}'
        + '@media (max-width:1100px){.cmp-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media (max-width:700px){.cmp-grid{grid-template-columns:1fr}}'
        + '</style>'
        + '<div class="page tight"><div class="cmp-page">'
        + '<div class="panel" style="gap:10px;padding:12px"><div class="cmp-prompt"><label class="sr" for="cmp-input">Prompt</label><input class="input" id="cmp-input" value="' + esc(st.prompt) + '" placeholder="Ask all columns the same thing">' + UI.btn('Add profile', { icon: 'plus', attrs: 'data-add', disabled: st.cols.length >= 4, title: st.cols.length >= 4 ? 'Compare takes at most four profiles' : '' }) + (anyStreaming ? UI.btn('Stop all', { icon: 'stop', attrs: 'data-stopall' }) : UI.btn('Send to ' + sendable.length, { kind: 'primary', icon: 'send', attrs: 'data-send', disabled: sendable.length < 2, title: sendable.length < 2 ? 'Compare needs at least two available profiles' : '' })) + '</div>'
        + '<div class="cmp-est"><span class="relative">' + UI.chip('Conversation label: ' + esc(st.label), false, 'data-labelpick') + '</span><span>Before sending: ' + sendable.length + ' of ' + cols.length + ' columns run, about ' + fmt(estTokens) + ' tokens and ' + estGpu.toFixed(1) + ' GPU-s, ' + sendable.length + ' usage rows. Each column is guardrailed and metered on its own.</span>' + (st.metered ? '' : '<a href="#" class="right" data-showusage>Show usage rows</a>') + '</div></div>'
        + '<div class="cmp-grid" data-n="' + cols.length + '" style="--n:' + cols.length + '">' + cols.map(column).join('') + '</div>'
        + usage
        + '<div style="margin-top:6px"><div class="eyebrow" style="margin-bottom:8px">States to design from this page</div>' + UI.states(this.states) + '</div>'
        + '</div></div>';

      ctx.on('input', '#cmp-input', (e, t) => { st.prompt = t.value; });
      ctx.on('keydown', '#cmp-input', (e) => { if (e.key === 'Enter') { e.preventDefault(); const b = ctx.$('[data-send]'); if (b) b.click(); } });
      ctx.on('click', '[data-send]', () => { if (!(st.prompt || '').trim()) { ctx.toast('Type a prompt first.'); return; } startStream(ctx, st); });
      ctx.on('click', '[data-stopall]', () => { stopStreams(st); cols.forEach((p) => { const r = st.results[p.id]; if (r && r.streaming) { r.streaming = false; r.done = true; } }); ctx.rerender(); ctx.toast('Cancelled. Each column\'s gateway slot is released and its usage row records the partial answer.'); });
      ctx.on('click', '[data-add]', () => {
        const free = PROFILES.filter((p) => !st.cols.includes(p.id));
        ctx.modal({ title: 'Add a profile', body: '<div class="fg2">Profiles allowed by policy in Finance Ops. Compare takes at most four.</div><div class="vstack gap4">' + free.map((p) => UI.listItem(esc(p.id) + (available(p, st.label) ? '' : ' ' + UI.pill('unavailable', 'warn')), '<span class="mono">' + esc(p.model) + '</span> · zone ' + esc(p.zone) + ', ceiling ' + esc(p.zoneCeiling), { attrs: 'data-pick="' + esc(p.id) + '"', right: UI.label(p.zoneCeiling, { sm: true }) })).join('') + '</div>', actions: UI.btn('Cancel', { attrs: 'data-close' }), onMount(m) { m.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => { App.closeOverlay(); st.cols.push(b.dataset.pick); ctx.rerender(); ctx.toast(esc(b.dataset.pick) + ' added. Send again to fill the new column.'); })); } });
      });
      ctx.on('click', '[data-remove]', (e, t) => { if (st.cols.length <= 2) { ctx.toast('Compare needs at least two profiles.'); return; } const r = st.results[t.dataset.remove]; if (r && r.timer) clearTimeout(r.timer); st.cols = st.cols.filter((c) => c !== t.dataset.remove); delete st.results[t.dataset.remove]; ctx.rerender(); });
      ctx.on('click', '[data-prof]', (e, t) => { e.preventDefault(); ctx.navigate('profiles', { profile: t.dataset.prof }); });
      ctx.on('click', '[data-rule]', (e) => { e.preventDefault(); ctx.navigate('guardrails'); });
      ctx.on('click', '[data-report]', (e) => { e.preventDefault(); ctx.navigate('flags', { id: 'F-2291' }); });
      ctx.on('click', '[data-showusage]', (e) => { e.preventDefault(); st.metered = true; ctx.rerender(); });
      ctx.on('click', '[data-continue]', async (e, t) => {
        const p = byId(t.dataset.continue);
        const ok = await ctx.confirm({ title: 'Continue with ' + esc(p.id), tone: 'primary', ok: 'Open conversation', body: '<div class="fg2">A conversation starts from this prompt and answer with profile <b>' + esc(p.id) + '</b>. The other ' + (cols.length - 1) + ' columns stay in the compare record and their usage rows, but not in the conversation.</div>', kv: [['Profile', esc(p.id)], ['Model', '<span class="mono">' + esc(p.model) + '</span>'], ['Label', UI.label(st.label, { sm: true })], ['Tokens carried over', fmt(st.results[p.id].tokens + 212)]] });
        if (!ok) return;
        stopStreams(st);
        ctx.toast('Continuing with <b>' + esc(p.id) + '</b>. Compare record kept under Usage and audit.', 'ok');
        ctx.navigate('chat', { convo: 'c2' });
      });
      ctx.on('click', '[data-labelpick]', (e, t) => {
        const host = t.closest('.relative'); const ex = host.querySelector('.dropdown'); ctx.$$('.dropdown').forEach((d) => d.remove()); if (ex) return;
        const d = document.createElement('div'); d.className = 'dropdown';
        d.innerHTML = '<div class="dh">Conversation label</div>' + ['internal', 'confidential'].map((l) => '<button type="button" data-lbl="' + l + '" class="' + (l === st.label ? 'on' : '') + '">' + UI.label(l, { sm: true }) + '</button>').join('') + '<div class="dh">Set by attached context; raising it disables profiles whose zone ceiling is lower</div>';
        host.appendChild(d);
        d.addEventListener('click', (ev) => { const b = ev.target.closest('[data-lbl]'); if (!b) return; st.label = b.dataset.lbl; d.remove(); ctx.rerender(); const off = st.cols.map(byId).filter((p) => !available(p, st.label)); if (off.length) ctx.toast(off.map((p) => p.id).join(', ') + ' disabled: zone ceiling below ' + st.label + '.', 'warn'); });
      });
      ctx.on('click', '.state-card', (e, t) => ctx.app.applyState(+t.dataset.state));
      if (st.focusPrompt) { st.focusPrompt = false; setTimeout(() => { const i = ctx.$('#cmp-input'); if (i) { i.focus(); i.select(); } }, 30); }
    }
  });
})();
