(function () {
  const { UI, esc } = App;

  // Compare: one prompt to two to four profiles in parallel (POST /api/compare). Each column is its own assistant
  // message that streams over the socket (chat.status, chat.chunk, chat.done) and is metered on its own.
  const RANK = { public: 1, internal: 2, confidential: 3, restricted: 4 };
  const LABELS = ['public', 'internal', 'confidential', 'restricted'];
  const THINK = ['off', 'low', 'medium', 'high'];
  const ACTIVE = { queued: true, streaming: true };
  const LIMIT_NAMES = { tokens_per_day: 'Tokens per day', gpu_seconds_per_month: 'GPU-seconds per month' };
  const BOARD_PROMPT = 'Summarise the limitation of liability clause in two sentences.';

  const S = () => App.stateFor('compare');
  const enc = encodeURIComponent;
  const fmt = (n) => Number(n || 0).toLocaleString('en-US');
  const secs = (ms) => (ms == null ? '—' : (ms / 1000).toFixed(2) + ' s');
  const gpuS = (ms) => (ms == null ? '—' : (ms / 1000).toFixed(1));
  const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
  const approxTokens = (c) => Math.ceil(((c.content || '').length + (c.thinking || '').length) / 4);
  const capThink = (want, ceiling) => (THINK.indexOf(want) > THINK.indexOf(ceiling) ? ceiling : want);
  const msgUrl = (cid, mid, tail) => '/api/conversations/' + enc(cid) + '/messages/' + enc(mid) + tail;

  function allowedLabels() {
    const clearance = (App.me && App.me.user && App.me.user.clearance) || 'internal';
    const ceiling = App.DATA.tenant && App.DATA.tenant.label;
    return LABELS.filter((l) => RANK[l] <= RANK[clearance] && (!ceiling || RANK[l] <= RANK[ceiling]));
  }
  const profileOf = (st, name) => (st.profiles || []).find((p) => p.name === name || p.id === name);
  /** Why a profile cannot take the next send, or null. */
  function unavailable(st, name) {
    if (st.unavailable && st.unavailable[name]) return st.unavailable[name];
    if (!st.profiles) return null;
    const p = profileOf(st, name);
    if (!p) return name + ' is not offered to you: it is not published, its model is retired, or it needs a higher clearance.';
    if (RANK[p.label] < RANK[st.label]) return name + ' is disabled for ' + (st.label === 'internal' ? 'an ' : 'a ') + st.label + ' conversation: its ceiling is ' + p.label + '.';
    return null;
  }
  const colFor = (st, name) => (st.run ? st.run.columns.find((c) => c.requested === name) : null);
  const findCol = (st, mid) => (st.run ? st.run.columns.find((c) => c.messageId === mid) : null);
  const activeCols = (st) => (st.run ? st.run.columns.filter((c) => ACTIVE[c.state]) : []);

  function freshCol(fields) {
    const now = Date.now();
    return Object.assign({ slot: 0, messageId: '', requested: '', profile: '', model: '', think: 'off', canary: false, state: 'queued', phase: 'queued', position: null, instance: null, fallbackFrom: null,
      content: '', thinking: '', tools: [], seq: 0, buf: {}, usage: null, error: null, sentAt: now, firstAt: null, lastAt: now, showThinking: false, pendingDone: null, catching: false, gapTimer: null }, fields);
  }
  function fromMessage(m) {
    return freshCol({ slot: m.compareSlot == null ? 0 : m.compareSlot, messageId: m.id, requested: m.profile || '', profile: m.profile || '', model: m.model || '', think: m.think || 'off', canary: !!m.canary,
      state: m.state, phase: ACTIVE[m.state] ? m.state : null, content: m.content || '', thinking: m.thinking || '', tools: m.tools || [], seq: m.seq || 0, usage: m.usage, error: m.error, sentAt: m.createdAt });
  }

  // ---------- socket: registered once per socket, always reading the current screen state ----------
  let bound = null;
  let orphans = []; // events for message ids not known yet (the POST answer can arrive after the first events)
  function bindSocket() {
    const sock = App.socket;
    if (!sock || bound === sock) return;
    bound = sock;
    sock.on('chat.status', (d) => dispatch('status', d));
    sock.on('chat.chunk', (d) => dispatch('chunk', d));
    sock.on('chat.done', (d) => dispatch('done', d));
    sock.on('connect', () => activeCols(S()).forEach((c) => catchUp(c)));
  }
  function dispatch(kind, d) {
    if (!d || !d.messageId) return;
    const col = findCol(S(), d.messageId);
    if (col) { handle(col, kind, d); return; }
    const now = Date.now();
    orphans = orphans.filter((o) => now - o.t < 60000).slice(-2000);
    orphans.push({ t: now, kind, d });
  }
  function adopt(col) {
    const mine = orphans.filter((o) => o.d.messageId === col.messageId);
    if (!mine.length) return;
    orphans = orphans.filter((o) => o.d.messageId !== col.messageId);
    mine.forEach((o) => handle(col, o.kind, o.d));
  }
  function handle(col, kind, d) {
    col.lastAt = Date.now();
    if (kind === 'status') {
      if (!ACTIVE[col.state]) return;
      col.phase = d.state;
      col.position = d.state === 'queued' ? (d.position != null ? d.position : col.position) : null;
      if (d.instance) col.instance = d.instance;
      if (d.state === 'fallback') col.fallbackFrom = d.from || col.profile;
      if (d.profile) col.profile = d.profile;
      if (d.model) col.model = d.model;
      if (d.state === 'streaming' || d.state === 'loading') col.state = 'streaming';
    } else if (kind === 'chunk') {
      onChunk(col, d);
    } else if (kind === 'done') {
      col.pendingDone = d;
      if (col.seq < (d.seq || 0)) catchUp(col); else finalize(col);
    }
    schedule(col);
  }
  function applyChunk(col, ch) {
    if (ch.delta) col.content += ch.delta;
    if (ch.thinking) col.thinking += ch.thinking;
    if (ch.tool) col.tools.push(ch.tool);
    col.seq = ch.seq;
    if (!col.firstAt && (ch.delta || ch.thinking)) col.firstAt = Date.now();
    if (col.state === 'queued') col.state = 'streaming';
    if (col.phase !== 'fallback' || ch.delta || ch.thinking) col.phase = 'streaming';
  }
  function drain(col) {
    while (col.buf[col.seq + 1]) { const ch = col.buf[col.seq + 1]; delete col.buf[col.seq + 1]; applyChunk(col, ch); }
    Object.keys(col.buf).forEach((k) => { if (+k <= col.seq) delete col.buf[k]; });
  }
  function onChunk(col, ch) {
    if (ch.seq <= col.seq) return;
    if (ch.seq === col.seq + 1) { applyChunk(col, ch); drain(col); return; }
    col.buf[ch.seq] = ch;
    // A gap: give a late chunk a moment, then ask the server for what we missed.
    if (!col.gapTimer) col.gapTimer = setTimeout(() => { col.gapTimer = null; if (Object.keys(col.buf).length) catchUp(col); }, 250);
  }
  function finalize(col) {
    const d = col.pendingDone;
    if (!d) return;
    col.pendingDone = null;
    col.state = d.state; col.usage = d.usage || col.usage; col.error = d.error || null; col.phase = null; col.position = null; col.buf = {};
    if (d.profile) col.profile = d.profile;
    if (d.model) col.model = d.model;
  }
  /** GET …/stream?after=<seq>: the missing chunks while streaming, or the stored message once it has settled. */
  async function catchUp(col) {
    const st = S();
    if (!st.run || col.catching) return;
    const cid = st.run.conversationId, mid = col.messageId;
    col.catching = true; col.lastAt = Date.now();
    try {
      const r = await App.get(msgUrl(cid, mid, '/stream?after=' + col.seq));
      if (col.messageId !== mid) return;
      if (r.chunks) {
        r.chunks.slice().sort((a, b) => a.seq - b.seq).forEach((ch) => { if (ch.seq === col.seq + 1) applyChunk(col, ch); else if (ch.seq > col.seq) col.buf[ch.seq] = ch; });
        drain(col);
        if (!ACTIVE[r.state] && !col.pendingDone) await settleFromView(cid, col);
      } else {
        col.content = r.content || ''; col.thinking = r.thinking || ''; col.tools = r.tools || []; col.seq = r.seq || 0; col.buf = {};
        if (!ACTIVE[r.state]) { col.state = r.state; col.usage = r.usage || col.usage; col.error = r.error || null; col.phase = null; }
      }
      if (col.pendingDone && col.seq >= (col.pendingDone.seq || 0)) finalize(col);
    } catch (err) {
      if (err && err.status === 404) { col.state = 'failed'; col.error = 'This answer no longer exists.'; col.phase = null; }
    } finally {
      col.catching = false; col.lastAt = Date.now(); schedule(col);
    }
  }
  /** The done event was missed: the settled message (with its usage) comes from the conversation view. */
  async function settleFromView(cid, col) {
    const v = await App.get('/api/conversations/' + enc(cid));
    const m = (v.messages || []).find((x) => x.id === col.messageId);
    if (!m || ACTIVE[m.state]) return;
    Object.assign(col, { state: m.state, content: m.content || '', thinking: m.thinking || '', tools: m.tools || [], seq: m.seq || col.seq, usage: m.usage, error: m.error, phase: null, position: null });
  }
  // A quiet column (a missed event, a dropped socket, a long queue) is checked against the server every few seconds.
  let watchdog = null;
  function startWatchdog() {
    if (watchdog) return;
    watchdog = setInterval(() => {
      const now = Date.now();
      activeCols(S()).forEach((c) => { if (!c.catching && now - c.lastAt > 5000) catchUp(c); });
    }, 2000);
  }

  // ---------- throttled in-place updates while streaming (a full render would scroll to the top and close dialogs) ----------
  let dirty = {}, flushTimer = null;
  function schedule(col) {
    dirty[col ? col.messageId : '*'] = true;
    if (!flushTimer) flushTimer = setTimeout(flush, 120);
  }
  function flush() {
    flushTimer = null;
    const d = dirty; dirty = {};
    if (App.state.route !== 'compare') return;
    const main = document.getElementById('main');
    const st = S();
    if (!main || !st.cols) return;
    st.cols.forEach((name, i) => {
      const col = colFor(st, name);
      if (!col || (!d['*'] && !d[col.messageId])) return;
      const el = main.querySelector('[data-colidx="' + i + '"]');
      if (el) { el.className = colClass(st, name); el.innerHTML = columnInner(st, name); }
    });
    const a = main.querySelector('#cp-actions'); if (a) a.innerHTML = actionsHtml(st);
    const u = main.querySelector('#cp-usage-wrap'); if (u) u.innerHTML = usageHtml(st);
  }

  // ---------- pieces of the page (shared by render and the in-place updates) ----------
  function colClass(st, name) { return 'cp-col panel' + (unavailable(st, name) ? ' off' : ''); }

  function statusPill(col) {
    if (col.state === 'queued' || (ACTIVE[col.state] && col.phase === 'queued')) return UI.pill(col.position ? 'queued, position ' + col.position : 'queued', 'warn');
    if (col.phase === 'fallback') return UI.pill('fallback', 'warn');
    if (col.phase === 'loading' && !col.firstAt) return UI.pill('loading model', 'info');
    if (ACTIVE[col.state]) return UI.pill('streaming', 'info');
    if (col.state === 'complete') return UI.pill('complete', 'ok');
    if (col.state === 'stopped') return UI.pill('stopped', 'warn');
    return UI.pill('failed', 'danger');
  }

  function metricsHtml(col) {
    const m = (k, v) => '<div><span class="k">' + esc(k) + '</span><span class="v num">' + v + '</span></div>';
    if (!col) return '<div class="cp-metrics muted">' + m('First token', '—') + m('Tokens in', '—') + m('Tokens out', '—') + m('GPU-s', '—') + '</div>';
    const u = col.usage;
    if (u && !ACTIVE[col.state]) return '<div class="cp-metrics">' + m('First token', esc(secs(u.firstTokenMs))) + m('Tokens in', fmt(u.promptTokens)) + m('Tokens out', fmt(u.outputTokens)) + m('GPU-s', esc(gpuS(u.gpuMs))) + '</div>';
    const ft = col.firstAt ? secs(col.firstAt - col.sentAt) : '…';
    const out = col.content || col.thinking ? '≈' + fmt(approxTokens(col)) : '…';
    return '<div class="cp-metrics cp-live" title="Live values settle when the final chunk arrives">' + m('First token', esc(ft)) + m('Tokens in', '…') + m('Tokens out', out) + m('GPU-s', '…') + '</div>';
  }

  function thinkNote(st, name, col) {
    if (col) return 'Thinking: ' + esc(col.think) + (col.canary ? ' · canary model' : '');
    const p = profileOf(st, name);
    if (!p) return '';
    const want = st.think || p.thinkDefault;
    const got = capThink(want, p.thinkCeiling);
    return 'Thinking: ' + esc(got) + (got !== want ? ' (capped from ' + esc(want) + ' by the profile)' : '');
  }

  function columnInner(st, name) {
    const col = colFor(st, name);
    const u = unavailable(st, name);
    const p = profileOf(st, name);
    const title = col ? col.profile : name;
    const model = col ? col.model : (p ? p.model : '');
    const nameHtml = App.can('profiles:manage') ? '<a href="#" data-prof="' + esc(title) + '" class="cp-plink">' + esc(title) + '</a>' : esc(title);
    let head = '<div class="hstack" style="align-items:flex-start"><div class="grow" style="min-width:0"><div class="cp-name">' + nameHtml + ' ' + (col ? statusPill(col) : '') + (col && col.canary ? ' ' + UI.pill('canary', 'info') : '') + '</div>'
      + '<span class="mono fg2 cp-model">' + esc(model || '—') + '</span>'
      + '<div class="muted cp-note">' + thinkNote(st, name, col) + (col && col.fallbackFrom ? ' · fallback from ' + esc(col.fallbackFrom) : '') + (col && col.phase === 'loading' && col.instance && !col.firstAt ? ' · loading on ' + esc(col.instance) : '') + '</div></div>'
      + UI.iconbtn('x', 'Remove column', { cls: 'sm ghost', attrs: 'data-remove="' + esc(name) + '"' }) + '</div>';
    let body = '';
    if (u) body += UI.notice(esc(u), 'warn') + (col ? '' : '<div class="muted" style="font-size:12px">' + (profileOf(st, name) ? 'Lower the conversation label or pick a profile whose ceiling covers it.' : 'Remove this column or pick another profile.') + '</div>');
    if (!col) {
      if (!u) body += '<div class="cp-answer serif muted">No answer yet. Send the prompt to run this column.</div>';
      return head + metricsHtml(null) + body + (u ? UI.btn('Continue with ' + name, { disabled: true, title: 'This profile cannot take this conversation' }) : '');
    }
    if (col.thinking) {
      body += '<div class="cp-think">' + '<button type="button" class="cp-thinkbtn" data-think="' + esc(name) + '" aria-expanded="' + (col.showThinking ? 'true' : 'false') + '">' + App.icon(col.showThinking ? 'chevd' : 'chev', 13) + 'Thinking' + (ACTIVE[col.state] && !col.content ? '…' : '') + ' <span class="muted">' + fmt(col.thinking.split(/\s+/).filter(Boolean).length) + ' words' + (col.usage && col.usage.thinkingTokens ? ', ' + fmt(col.usage.thinkingTokens) + ' tokens' : '') + '</span></button>'
        + (col.showThinking ? '<div class="cp-thinktext">' + esc(col.thinking) + '</div>' : '') + '</div>';
    }
    if (col.tools && col.tools.length) body += '<div class="vstack gap4">' + col.tools.map((t) => '<div class="cp-tool mono">' + esc(t.name) + ': ' + esc(t.expression) + ' = ' + (t.result ? esc(t.result.decimal) + (t.result.exact ? '' : ' (rounded)') : esc(t.error || '')) + '</div>').join('') + '</div>';
    const cursor = ACTIVE[col.state] ? '<span class="blink">▍</span>' : '';
    if (col.content || ACTIVE[col.state]) body += '<div class="cp-answer serif">' + esc(col.content) + cursor + (!col.content && ACTIVE[col.state] && !col.thinking ? '<span class="muted">' + (col.state === 'queued' ? 'Waiting for a slot.' : 'Waiting for the first token.') + '</span>' : '') + '</div>';
    else if (col.state === 'complete') body += '<div class="cp-answer serif muted">The model returned an empty answer.</div>';
    if (col.state === 'stopped') body += UI.notice('Stopped. What was produced is kept and metered. Other columns are unaffected.', 'warn');
    if (col.state === 'failed') body += UI.notice(esc(col.error || 'The answer failed.'), 'danger');

    let acts = '';
    if (ACTIVE[col.state]) acts += UI.btn('Stop', { size: 'sm', icon: 'stop', attrs: 'data-stop="' + esc(name) + '"' });
    else acts += UI.btn('Regenerate', { size: 'sm', icon: 'refresh', attrs: 'data-regen="' + esc(name) + '"', disabled: !!u, title: u ? 'This profile cannot take this conversation' : 'A new answer from ' + col.profile + ' in this column' });
    const label = 'Continue with ' + col.profile;
    if (ACTIVE[col.state]) acts += UI.btn(label, { size: 'sm', disabled: true, title: 'Available when the answer settles' });
    else if (col.state !== 'complete') acts += UI.btn(label, { size: 'sm', disabled: true, title: 'Stopped answers cannot start a conversation' });
    else if (u) acts += UI.btn(label, { size: 'sm', disabled: true, title: 'This profile cannot take this conversation' });
    else acts += UI.btn(label, { size: 'sm', attrs: 'data-continue="' + esc(name) + '"', title: 'Starts a new chat with the same prompt' });
    return head + metricsHtml(col) + body + '<div class="hstack wrap gap6 cp-acts">' + acts + '</div>';
  }

  function sendable(st) { return (st.cols || []).filter((n) => !unavailable(st, n)); }

  function actionsHtml(st) {
    const cols = st.cols || [];
    const n = sendable(st).length;
    const add = UI.btn('Add a profile', { icon: 'plus', attrs: 'data-add', disabled: cols.length >= 4, title: cols.length >= 4 ? 'Compare takes at most four profiles' : '' });
    if (activeCols(st).length) return add + UI.btn('Stop all', { icon: 'stop', attrs: 'data-stopall' });
    return add + UI.btn(st.sending ? 'Sending…' : 'Send to ' + n, { kind: 'primary', icon: 'send', attrs: 'data-send', disabled: n < 2 || !!st.sending, title: n < 2 ? 'Compare needs at least two available profiles' : '' });
  }

  function usageRow(c, replaced) {
    const u = c.usage;
    const settled = u && !ACTIVE[c.state];
    return ['<span class="mono" title="' + esc(c.messageId) + '">' + esc(c.messageId.slice(-8)) + '</span>', esc(c.profile), '<span class="mono">' + esc(c.model) + '</span>', esc(c.think),
      replaced ? UI.pill('replaced', 'outline') : ACTIVE[c.state] ? UI.pill('running', 'info') : UI.pill(c.state),
      settled ? fmt(u.promptTokens) : '—', settled ? fmt(u.outputTokens) : ACTIVE[c.state] ? '≈' + fmt(approxTokens(c)) : '—', settled ? fmt(u.thinkingTokens) : '—', settled ? esc(gpuS(u.gpuMs)) : '—', settled ? esc(secs(u.firstTokenMs)) : '—'];
  }
  function usageHtml(st) {
    if (!st.metered) return '';
    const head = '<div class="phead"><div class="eyebrow">Usage rows for this send</div><span class="muted" style="font-size:12px">Metered separately: one row per column, each with its own label</span></div>';
    if (!st.run) return '<section class="panel" id="cp-usage">' + head + '<div class="muted" style="font-size:13px">Nothing sent yet. Each column writes its own usage row when its answer settles.</div></section>';
    const all = st.run.columns.map((c) => ({ c, replaced: false })).concat((st.run.retired || []).map((c) => ({ c, replaced: true })));
    const settled = all.filter((x) => x.c.usage && !ACTIVE[x.c.state]);
    const tokens = settled.reduce((a, x) => a + x.c.usage.promptTokens + x.c.usage.outputTokens, 0);
    const gpu = settled.reduce((a, x) => a + x.c.usage.gpuMs, 0);
    const metered = settled.filter((x) => x.c.usage.promptTokens + x.c.usage.outputTokens > 0).length;
    return '<section class="panel" id="cp-usage">' + head
      + UI.table(['Message', 'Profile', 'Model', 'Thinking', 'State', { label: 'Tokens in', right: true }, { label: 'Tokens out', right: true }, { label: 'Thinking tokens', right: true }, { label: 'GPU-s', right: true }, { label: 'First token', right: true }],
        all.map((x) => usageRow(x.c, x.replaced)), { clickable: false, minWidth: '0' })
      + '<div class="muted" style="font-size:12px">Combined for this comparison: ' + fmt(tokens) + ' tokens, ' + (gpu / 1000).toFixed(1) + ' GPU-s, ' + metered + ' usage row' + (metered === 1 ? '' : 's') + (all.length > settled.length ? ' so far' : '') + '. Every row carries the ' + esc(st.run.label) + ' label and appears under Usage and audit.</div></section>';
  }

  function problemHtml(st) {
    const pr = st.problem;
    if (!pr) return '';
    const p = (pr.err && pr.err.problem) || {};
    const dismiss = UI.btn('Dismiss', { kind: 'ghost', size: 'sm', attrs: 'data-dismiss' });
    if (pr.kind === 'quota') {
      const kv = [['Limit', esc(LIMIT_NAMES[p.limit] || p.limit || 'quota')], ['Used', p.max != null ? fmt(p.used) + ' of ' + fmt(p.max) : '—'], ['Scope', esc(p.scope || '—')], ['Resets', p.resets_at ? esc(new Date(p.resets_at).toLocaleString()) : '—'], ['Can raise it', esc(p.raised_by || 'a tenant admin')]];
      return '<section class="panel">' + UI.notice('<b>Over quota.</b> ' + esc(p.detail || pr.err.message), 'warn', dismiss) + UI.kv(kv, 5) + '</section>';
    }
    if (pr.kind === 'unavailable') return UI.notice('<b>Profile unavailable.</b> ' + esc(p.detail || pr.err.message) + ' Nothing was sent. Remove the column or pick another profile.', 'warn', dismiss);
    if (pr.kind === 'forbidden') return '<div class="vstack gap6">' + UI.problem(p.step === 'zone' ? 'A profile cannot take this label' : p.step === 'clearance' ? 'Above your clearance' : 'Not permitted', p.detail || pr.err.message, p.trace_id || false) + '<div>' + dismiss + '</div></div>';
    return UI.notice('<b>' + esc(p.title || 'Not sent') + '.</b> ' + esc(p.detail || pr.err.message), 'danger', dismiss);
  }

  function historyHtml(st) {
    const list = st.history || [];
    return '<div class="hstack"><div class="eyebrow grow">Comparisons</div>' + UI.btn('New', { size: 'sm', icon: 'plus', attrs: 'data-new' }) + '</div>'
      + (list.length ? '<div class="vstack gap4">' + list.map((c) => UI.listItem(esc(c.title || 'Untitled comparison'), esc(when(c.updatedAt)), { active: st.run && st.run.conversationId === c.id, attrs: 'data-open="' + esc(c.id) + '"', right: UI.label(c.label, { sm: true }) })).join('') + '</div>'
        : '<div class="muted" style="font-size:12px;padding:4px 2px">No comparisons yet. Each one you send is kept here.</div>');
  }

  // ---------- actions ----------
  function sendError(st, err, names) {
    const status = err && err.status;
    if (status === 429) st.problem = { kind: 'quota', err };
    else if (status === 409) {
      const detail = (err.problem && err.problem.detail) || '';
      const name = names.find((n) => detail.indexOf(n) >= 0);
      st.unavailable = st.unavailable || {};
      if (name) st.unavailable[name] = detail;
      st.problem = { kind: 'unavailable', err };
    } else if (status === 403) st.problem = { kind: 'forbidden', err };
    else if (status === 400 || status === 404) st.problem = { kind: 'bad', err };
    else { st.problem = null; App.fail(err, 'Could not send the comparison'); }
  }

  async function send(ctx) {
    const st = ctx.state;
    const prompt = (st.prompt || '').trim();
    if (!prompt) { ctx.toast('Type a prompt first.'); return; }
    const names = sendable(st);
    if (names.length < 2) { ctx.toast('Compare needs at least two available profiles.'); return; }
    if (st.sending) return;
    st.sending = true; st.problem = null;
    ctx.rerender();
    try {
      const body = { prompt, profiles: names, label: st.label };
      if (st.think) body.think = st.think;
      const r = await App.post('/api/compare', body);
      st.run = { conversationId: r.conversationId, prompt, label: st.label, columns: r.columns.map((c) => freshCol({ slot: c.slot, messageId: c.messageId, requested: names[c.slot], profile: c.profile, model: c.model, think: c.think, canary: !!c.canary })), retired: [] };
      st.run.columns.forEach(adopt);
      st.history = [{ id: r.conversationId, title: prompt.replace(/\s+/g, ' ').slice(0, 80), label: st.label, updatedAt: Date.now() }].concat((st.history || []).filter((h) => h.id !== r.conversationId));
    } catch (err) {
      sendError(st, err, names);
      if (err && err.status === 409) st.loaded = false; // the profile list may have changed
    } finally {
      st.sending = false;
      if (App.state.route === 'compare') ctx.rerender();
    }
  }

  async function stop(col, quiet) {
    const st = S();
    if (!st.run || !ACTIVE[col.state]) return;
    try {
      await App.post(msgUrl(st.run.conversationId, col.messageId, '/stop'));
      if (!quiet) App.toast('Stopped ' + esc(col.profile) + '. What it produced is kept and metered.');
    } catch (err) { App.fail(err, 'Could not stop the column'); }
  }

  async function regenerate(ctx, name) {
    const st = ctx.state;
    const col = colFor(st, name);
    if (!col || !st.run || ACTIVE[col.state]) return;
    try {
      const body = st.think ? { think: st.think } : {};
      const r = await App.post(msgUrl(st.run.conversationId, col.messageId, '/regenerate'), body);
      st.run.retired = (st.run.retired || []).concat(Object.assign({}, col));
      Object.assign(col, freshCol({ slot: col.slot, messageId: r.messageId, requested: col.requested, profile: r.profile, model: r.model, think: r.think, canary: col.canary, showThinking: col.showThinking }));
      adopt(col);
      ctx.toast('Regenerating ' + esc(r.profile) + '. The earlier answer stays in the comparison record and its usage row.');
    } catch (err) {
      if (err && err.status === 429) st.problem = { kind: 'quota', err };
      else if (err && (err.status === 409 || err.status === 403)) sendError(st, err, [name]);
      else App.fail(err, 'Could not regenerate');
    }
    if (App.state.route === 'compare') ctx.rerender();
  }

  async function openRun(ctx, id) {
    const st = ctx.state;
    try {
      const v = await App.get('/api/conversations/' + enc(id));
      const user = (v.messages || []).find((m) => m.role === 'user');
      const bySlot = {};
      (v.messages || []).filter((m) => m.role === 'assistant').forEach((m) => { const k = m.compareSlot == null ? 0 : m.compareSlot; (bySlot[k] = bySlot[k] || []).push(m); });
      const columns = [], retired = [], seen = {};
      Object.keys(bySlot).map(Number).sort((a, b) => a - b).forEach((k) => {
        const list = bySlot[k].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
        list.slice(0, -1).forEach((m) => retired.push(fromMessage(m)));
        const col = fromMessage(list[list.length - 1]);
        if (seen[col.requested]) col.requested = col.requested + ' (' + (k + 1) + ')';
        seen[col.requested] = true;
        columns.push(col);
      });
      st.run = { conversationId: v.id, prompt: user ? user.content : '', label: v.label, columns, retired };
      st.cols = columns.map((c) => c.requested);
      st.prompt = st.run.prompt; st.label = v.label; st.problem = null;
      columns.filter((c) => ACTIVE[c.state]).forEach((c) => { adopt(c); catchUp(c); });
    } catch (err) { App.fail(err, 'Could not open the comparison'); }
    if (App.state.route === 'compare') ctx.rerender();
  }

  App.register({
    id: 'compare', title: 'Compare', live: true,
    summary: 'One prompt to two to four profiles, each streamed and metered separately',
    crumb: ['Chat', 'Compare'],
    label: (st) => (st.run ? st.run.label : st.label || 'internal'),
    commands: [{ label: 'Compare profiles on a prompt', sub: 'Compare', run(app) { app.stateFor('compare').focusPrompt = true; app.render(); } }],
    states: [
      { title: 'Profile unavailable', tone: 'warn', text: 'A profile whose ceiling is below the conversation label is disabled for it. Shown disabled with the reason.',
        apply(ctx) {
          const st = ctx.state; const ps = st.profiles || []; const labels = allowedLabels().slice().reverse();
          for (let i = 0; i < labels.length; i++) {
            const p = ps.find((x) => RANK[x.label] < RANK[labels[i]]);
            if (p) { st.label = labels[i]; if ((st.cols || []).indexOf(p.name) < 0) st.cols = (st.cols || []).slice(0, 3).concat(p.name); ctx.rerender(); return; }
          }
          ctx.toast('Every profile you may use covers every label you may pick, so none is disabled here. A profile that is not published or has no usable model is refused when sending, and its column shows the reason.', '', 8000);
        } },
      { title: 'Two columns', tone: 'neutral', text: 'With two profiles each column widens to the 72 character reading measure.',
        apply(ctx) {
          const st = ctx.state; const extra = (st.profiles || []).map((p) => p.name).filter((n) => (st.cols || []).indexOf(n) < 0);
          st.cols = (st.cols || []).concat(extra).slice(0, 2); ctx.rerender();
        } },
      { title: 'Metered separately', tone: 'neutral', text: 'Each column writes its own usage row: tokens in and out, GPU-seconds and first-token latency.',
        apply(ctx) { ctx.state.metered = true; ctx.rerender(); setTimeout(() => { const u = ctx.$('#cp-usage'); if (u) u.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, 30); } },
      { title: 'Still streaming', tone: 'info', text: 'Metrics show live values and settle when the final chunk arrives.',
        apply(ctx) {
          const st = ctx.state;
          if (activeCols(st).length) { ctx.toast('Columns are already streaming.'); return; }
          if (!(st.prompt || '').trim()) st.prompt = BOARD_PROMPT;
          send(ctx);
        } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      bindSocket(); startWatchdog();
      const labels = allowedLabels();
      if (!st.label || labels.indexOf(st.label) < 0) st.label = labels.indexOf('internal') >= 0 ? 'internal' : labels[labels.length - 1] || 'public';
      if (st.prompt == null) st.prompt = '';
      if (st.think == null) st.think = '';

      const load = () => {
        if (st.loading) return;
        st.loading = true;
        Promise.all([App.get('/api/chat/profiles'), App.get('/api/conversations?kind=compare&limit=50')])
          .then(([profiles, history]) => {
            Object.assign(st, { profiles, history, loaded: true, loadError: null, unavailable: {} });
            if (!st.cols) { const ok = profiles.filter((p) => RANK[p.label] >= RANK[st.label]).map((p) => p.name); st.cols = ok.slice(0, Math.min(4, ok.length)); }
          })
          .catch((err) => { st.loadError = err; })
          .finally(() => { st.loading = false; if (App.state.route === 'compare') ctx.rerender(); });
      };
      if (!st.loaded && !st.loadError) load();
      if (ctx.params.convo && st.openedParam !== ctx.params.convo) { st.openedParam = ctx.params.convo; if (!st.run || st.run.conversationId !== ctx.params.convo) openRun(ctx, ctx.params.convo); }

      const style = '<style>'
        + '.cp-page{display:flex;flex-direction:column;gap:14px;padding:18px 22px}'
        + '.cp-prompt{display:flex;gap:10px;align-items:center}.cp-prompt input{flex-grow:1;height:34px;font-size:14px}'
        + '.cp-grid{display:grid;gap:12px;grid-template-columns:repeat(var(--n,4),minmax(0,1fr));align-items:stretch}'
        + '.cp-col{gap:12px;padding:16px;min-width:0}.cp-col.off{background:var(--panel2)}'
        + '.cp-name{font-size:14px;font-weight:600;display:flex;align-items:center;gap:6px;flex-wrap:wrap}.cp-plink{color:inherit;text-decoration:none}.cp-plink:hover{text-decoration:underline}'
        + '.cp-model{font-size:12px;overflow-wrap:anywhere}.cp-note{font-size:12px;margin-top:2px}'
        + '.cp-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;padding:8px 0;border-top:1px solid var(--line2);border-bottom:1px solid var(--line2)}'
        + '.cp-metrics > div{display:flex;flex-direction:column;min-width:0}.cp-metrics .k{font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:700}.cp-metrics .v{font-size:15px;font-weight:600}.cp-live .v{color:var(--fg2)}'
        + '.cp-grid[data-n="3"] .cp-metrics,.cp-grid[data-n="4"] .cp-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.cp-metrics .v{white-space:nowrap}'
        + '.cp-answer{font-size:15px;line-height:1.6;flex-grow:1;white-space:pre-wrap;overflow-wrap:anywhere}.cp-grid[data-n="2"] .cp-answer{max-width:72ch;font-size:16px}'
        + '.cp-think{border:1px solid var(--line2);border-radius:6px;background:var(--panel2)}'
        + '.cp-thinkbtn .muted{font-weight:400}.cp-thinkbtn{display:flex;align-items:center;flex-wrap:wrap;gap:6px;width:100%;border:0;background:transparent;color:var(--fg2);font:inherit;font-size:12px;font-weight:600;padding:6px 8px;cursor:pointer;text-align:left}'
        + '.cp-thinktext{padding:0 10px 8px;font-size:13px;line-height:1.5;color:var(--fg2);white-space:pre-wrap;overflow-wrap:anywhere;max-height:240px;overflow-y:auto}'
        + '.cp-tool{font-size:12px;padding:4px 8px;border-radius:4px;background:var(--panel2)}'
        + '.cp-acts{margin-top:auto}'
        + '.cp-est{display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-size:12px;color:var(--muted)}.cp-est .select{height:26px;font-size:12px;width:auto}'
        + '@media (max-width:1100px){.cp-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media (max-width:700px){.cp-grid{grid-template-columns:1fr}}'
        + '</style>';

      if (st.loadError && !st.profiles) {
        root.innerHTML = style + '<div class="page">' + UI.problem('Compare could not be loaded', st.loadError.message, (st.loadError.problem && st.loadError.problem.trace_id) || false) + '<div>' + UI.btn('Try again', { attrs: 'data-retry' }) + '</div></div>';
        ctx.on('click', '[data-retry]', () => { st.loadError = null; ctx.rerender(); });
        return;
      }
      if (!st.profiles) { root.innerHTML = style + '<div class="page">' + UI.notice('Loading profiles…', 'info') + '</div>'; return; }

      const cols = st.cols || [];
      const n = sendable(st).length;
      const leftpane = '<div class="leftpane" id="cp-hist">' + historyHtml(st) + '</div>';
      let grid;
      if (st.profiles.length < 2 && !st.run) grid = UI.empty('Compare needs two profiles', 'You may use ' + st.profiles.length + ' published profile' + (st.profiles.length === 1 ? '' : 's') + ' in this workspace. A profile admin publishes more, or maps you to a higher clearance.');
      else grid = '<div class="cp-grid" data-n="' + cols.length + '" style="--n:' + Math.max(cols.length, 1) + '">' + cols.map((name, i) => '<div class="' + colClass(st, name) + '" data-colidx="' + i + '">' + columnInner(st, name) + '</div>').join('') + '</div>';

      const thinkSel = '<label class="hstack gap6"><span>Thinking</span>' + UI.select([{ value: '', label: 'Profile default' }].concat(THINK.map((t) => ({ value: t, label: t }))), st.think, 'data-thinksel aria-label="Thinking level"') + '</label>';
      root.innerHTML = style + leftpane + '<div class="page tight"><div class="cp-page">'
        + '<div class="panel" style="gap:10px;padding:12px"><div class="cp-prompt"><label class="sr" for="cp-input">Prompt</label><input class="input" id="cp-input" value="' + esc(st.prompt) + '" placeholder="Ask all columns the same thing" maxlength="100000"><span class="hstack gap6" id="cp-actions">' + actionsHtml(st) + '</span></div>'
        + '<div class="cp-est"><span class="relative">' + UI.chip('Conversation label: ' + esc(st.label), false, 'data-labelpick') + '</span>' + thinkSel
        + '<span>Before sending: ' + n + ' of ' + cols.length + ' columns run, ' + n + ' usage rows. Each column is streamed and metered on its own; thinking is capped per profile.</span>'
        + (st.metered ? '' : '<a href="#" class="right" data-showusage>Show usage rows</a>') + '</div></div>'
        + problemHtml(st)
        + (st.run ? '<div class="muted" style="font-size:12px">Showing the answers to <span class="fg2">' + esc(st.run.prompt.length > 120 ? st.run.prompt.slice(0, 120) + '…' : st.run.prompt) + '</span> · Sending again starts a new comparison.</div>' : '')
        + grid
        + '<div id="cp-usage-wrap">' + usageHtml(st) + '</div>'
        + '<div style="margin-top:6px"><div class="eyebrow" style="margin-bottom:8px">States to design from this page</div>' + UI.states(this.states) + '</div>'
        + '</div></div>';

      ctx.on('input', '#cp-input', (e, t) => { st.prompt = t.value; });
      ctx.on('keydown', '#cp-input', (e) => { if (e.key === 'Enter') { e.preventDefault(); const b = ctx.$('[data-send]'); if (b && !b.disabled) b.click(); } });
      ctx.on('change', '[data-thinksel]', (e, t) => { st.think = t.value; ctx.rerender(); });
      ctx.on('click', '[data-send]', () => send(ctx));
      ctx.on('click', '[data-stopall]', () => { const list = activeCols(st); Promise.all(list.map((c) => stop(c, true))).then(() => ctx.toast('Stopped ' + list.length + ' column' + (list.length === 1 ? '' : 's') + '. Each keeps what it produced, and its usage row records the partial answer.')); });
      ctx.on('click', '[data-stop]', (e, t) => { const c = colFor(st, t.dataset.stop); if (c) stop(c); });
      ctx.on('click', '[data-regen]', (e, t) => regenerate(ctx, t.dataset.regen));
      ctx.on('click', '[data-think]', (e, t) => { const c = colFor(st, t.dataset.think); if (c) { c.showThinking = !c.showThinking; schedule(c); } });
      ctx.on('click', '[data-dismiss]', () => { st.problem = null; ctx.rerender(); });
      ctx.on('click', '[data-new]', () => { st.run = null; st.problem = null; st.openedParam = null; if (ctx.params.convo) ctx.navigate('compare'); else ctx.rerender(); setTimeout(() => { const i = ctx.$('#cp-input'); if (i) i.focus(); }, 30); });
      ctx.on('click', '[data-open]', (e, t) => openRun(ctx, t.dataset.open));
      ctx.on('click', '[data-add]', () => {
        const free = st.profiles.filter((p) => cols.indexOf(p.name) < 0);
        const ws = (App.DATA.tenant && App.DATA.tenant.workspace) || 'this workspace';
        ctx.modal({ title: 'Add a profile', body: '<div class="fg2">Profiles you may use in ' + esc(ws) + '. Compare takes at most four.</div>'
          + (free.length ? '<div class="vstack gap4">' + free.map((p) => { const off = RANK[p.label] < RANK[st.label]; return UI.listItem(esc(p.displayName || p.name) + (p.displayName && p.displayName !== p.name ? ' <span class="muted mono">' + esc(p.name) + '</span>' : '') + (off ? ' ' + UI.pill('unavailable', 'warn') : '') + (p.deprecated ? ' ' + UI.pill('deprecated', 'warn') : ''), '<span class="mono">' + esc(p.model) + '</span> · ' + esc(p.residency) + ', thinking up to ' + esc(p.thinkCeiling) + (off ? ', ceiling below ' + esc(st.label) : ''), { attrs: 'data-pick="' + esc(p.name) + '"', right: UI.label(p.label, { sm: true }) }); }).join('') + '</div>'
            : UI.empty('Every profile is already a column', 'Remove a column to swap in another profile.')),
          actions: UI.btn('Cancel', { attrs: 'data-close' }),
          onMount(m) { m.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => { App.closeOverlay(); st.cols = (st.cols || []).concat(b.dataset.pick).slice(0, 4); ctx.rerender(); ctx.toast(esc(b.dataset.pick) + ' added. Send again to fill the new column.'); })); } });
      });
      ctx.on('click', '[data-remove]', (e, t) => {
        if (cols.length <= 2) { ctx.toast('Compare needs at least two profiles.'); return; }
        const c = colFor(st, t.dataset.remove);
        if (c && ACTIVE[c.state]) stop(c, true);
        st.cols = cols.filter((x) => x !== t.dataset.remove); ctx.rerender();
      });
      ctx.on('click', '[data-prof]', (e, t) => { e.preventDefault(); ctx.navigate('profiles', { profile: t.dataset.prof }); });
      ctx.on('click', '[data-showusage]', (e) => { e.preventDefault(); st.metered = true; ctx.rerender(); });
      ctx.on('click', '[data-continue]', async (e, t) => {
        const col = colFor(st, t.dataset.continue);
        if (!col || !st.run || col.state !== 'complete') return;
        const run = st.run;
        const ok = await ctx.confirm({ title: 'Continue with ' + col.profile, tone: 'primary', ok: 'Start the chat',
          body: '<div class="fg2">This starts a new chat with the same prompt, answered again by <b>' + esc(col.profile) + '</b>. The comparison, its ' + run.columns.length + ' answers and their usage rows stay as they are; the answers are not copied into the chat.</div>',
          kv: [['Profile', esc(col.profile)], ['Model', '<span class="mono">' + esc(col.model) + '</span>'], ['Thinking', esc(col.think)], ['Label', UI.label(run.label, { sm: true })]] });
        if (!ok) return;
        try {
          const r = await App.post('/api/chat', { content: run.prompt, profile: col.profile, think: col.think, label: run.label });
          ctx.toast('Started a new chat with ' + esc(col.profile) + ' from the same prompt. The comparison is kept in Compare.', 'ok');
          ctx.navigate('chat', { id: r.conversationId });
        } catch (err) {
          if (err && err.status === 429) { st.problem = { kind: 'quota', err }; if (App.state.route === 'compare') ctx.rerender(); } else App.fail(err, 'Could not start the chat');
        }
      });
      ctx.on('click', '[data-labelpick]', (e, t) => {
        const host = t.closest('.relative'); const ex = host.querySelector('.dropdown'); ctx.$$('.dropdown').forEach((d) => d.remove()); if (ex) return;
        const d = document.createElement('div'); d.className = 'dropdown';
        d.innerHTML = '<div class="dh">Conversation label</div>' + labels.map((l) => '<button type="button" data-lbl="' + l + '" class="' + (l === st.label ? 'on' : '') + '">' + UI.label(l, { sm: true }) + '</button>').join('') + '<div class="dh">Raising it disables profiles whose ceiling is lower</div>';
        host.appendChild(d);
        d.addEventListener('click', (ev) => {
          const b = ev.target.closest('[data-lbl]'); if (!b) return;
          st.label = b.dataset.lbl; d.remove(); ctx.rerender();
          const off = (st.cols || []).filter((name) => { const p = profileOf(st, name); return p && RANK[p.label] < RANK[st.label]; });
          if (off.length) ctx.toast(esc(off.join(', ')) + ' disabled: ceiling below ' + esc(st.label) + '.', 'warn');
        });
      });
      ctx.on('click', '.state-card', (e, t) => ctx.app.applyState(+t.dataset.state));
      if (st.focusPrompt) { st.focusPrompt = false; setTimeout(() => { const i = ctx.$('#cp-input'); if (i) { i.focus(); i.select(); } }, 30); }
    }
  });
})();
