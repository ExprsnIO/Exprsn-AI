(function () {
  const { UI, esc } = App;

  // Chat, backed by /api/chat, /api/conversations and /api/attachments. Answers stream over the socket
  // (chat.status, chat.chunk, chat.done); a gap in the sequence numbers is filled from the stream endpoint.
  // Knowledge bases attach to a conversation (/api/conversations/:id/knowledge); answers that used retrieved
  // passages or memories carry numbered citations, shown as sources under the answer and in the inspector.
  const LEVELS = ['off', 'low', 'medium', 'high'];
  const LABELS = ['public', 'internal', 'confidential', 'restricted'];
  const enc = encodeURIComponent;
  const cUrl = (id) => '/api/conversations/' + enc(id);
  const mUrl = (cid, mid) => cUrl(cid) + '/messages/' + enc(mid);
  const S = () => App.stateFor('chat');
  const visible = () => App.state.route === 'chat' && App.state.signedIn;
  const num = (n) => Number(n || 0).toLocaleString('en-US');
  const rank = (l) => LABELS.indexOf(l);
  // A new conversation's label: internal, or the current workspace's ceiling when that is lower (as the server does).
  const newLabel = () => {
    const me = App.me || {};
    const w = (me.workspaces || []).find((x) => x.id === me.workspace);
    return w && rank(w.label) >= 0 && rank(w.label) < rank('internal') ? w.label : 'internal';
  };
  const active = (m) => m && m.role === 'assistant' && (m.state === 'queued' || m.state === 'streaming');
  const ago = (ms) => {
    if (!ms) return '';
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  };
  const size = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : b >= 1024 ? Math.round(b / 1024) + ' KB' : b + ' B');
  const ms = (v) => (v == null ? '' : v >= 1000 ? (v / 1000).toFixed(1) + ' s' : Math.round(v) + ' ms');

  // Attachment names for message chips, fetched once per id.
  const attCache = {};

  // ---------- state helpers ----------
  const byId = (st, id) => (st.conv && st.byId ? st.byId[id] : null);
  const profileOf = (st, name) => (st.profiles || []).find((p) => p.name === name || p.id === name) || null;
  const selProfile = (st) => profileOf(st, st.profile);
  const levelsFor = (p) => (p ? LEVELS.slice(0, LEVELS.indexOf(p.thinkCeiling) + 1) : ['off']);
  const clampThink = (p, want) => { const ok = levelsFor(p); return ok.indexOf(want) >= 0 ? want : ok[ok.length - 1]; };

  /** The knowledge bases attached to the open conversation, or picked for the one the next message starts. */
  const boundIds = (st) => (st.convId ? st.bound || [] : st.newKbs || []);
  const kbOf = (st, id) => (st.kbs || []).find((k) => k.id === id) || null;
  function loadBindings(id) {
    const st = S(); if (!id || !App.can('context:read')) return;
    App.get(cUrl(id) + '/knowledge').then((list) => { if (S().convId !== id) return; st.bound = list.map((k) => k.id); rerender(); }).catch(() => { /* the chip shows none */ });
  }
  async function toggleKb(id) {
    const st = S(); const cur = boundIds(st); const kb = kbOf(st, id);
    const on = cur.indexOf(id) < 0;
    const next = on ? cur.concat([id]) : cur.filter((x) => x !== id);
    const name = kb ? kb.name : 'The knowledge base';
    if (!st.convId) { st.newKbs = next; App.toast(esc(name) + (on ? ' will be searched for this conversation from its first message.' : ' removed.')); rerender(); return; }
    try {
      const r = await App.api('PUT', cUrl(st.convId) + '/knowledge', { kbIds: next });
      st.bound = r.kbIds;
      App.toast(esc(name) + (on ? ' attached. Later answers search it and cite what they use.' : ' detached from this conversation.'), 'ok');
    } catch (err) { handleError(err, 'Could not change the knowledge bases'); }
    rerender();
  }
  /** A citation's title and the line under it. */
  function citeText(c) {
    if (c.kind === 'memory') return { title: 'Memory, ' + (c.type || 'note'), sub: c.scope === 'workspace' ? 'Workspace memory' : 'Your memory' };
    const score = typeof c.score === 'number' ? ', score ' + c.score.toFixed(2) : '';
    return { title: c.document || 'Document', sub: (c.kb || 'Knowledge base') + (c.section ? ', ' + c.section : '') + score };
  }
  /** The quoted passage stored with a knowledge citation, or why it is not shown. */
  function passageHtml(c) {
    if (c.restricted) return '<span class="muted s ch-pass">The quoted passage is above your clearance.</span>';
    return c.passage ? '<span class="s ch-pass">“' + esc(c.passage) + '”</span>' : '';
  }
  function sourcesHtml(m, cls) {
    return (m.citations || []).map((c) => { const t = citeText(c); return '<button type="button" class="' + cls + '" data-src="' + esc(c.n) + '" data-mid="' + esc(m.id) + '"><span class="n">' + esc(c.n) + '</span><span class="grow"><span class="t">' + esc(t.title) + '</span><span class="muted s">' + esc(t.sub) + '</span>' + passageHtml(c) + '</span>' + (c.label ? UI.label(c.label, { sm: true }) : '') + '</button>'; }).join('');
  }

  function pickProfile(st, preferred) {
    const list = st.profiles || [];
    const keep = profileOf(st, preferred) || profileOf(st, st.profile) || list.find((p) => !p.deprecated) || list[0] || null;
    if (!keep) { st.profile = null; st.think = 'off'; return; }
    if (keep.name !== st.profile) { st.profile = keep.name; st.think = keep.thinkDefault; }
    st.think = clampThink(keep, st.think || keep.thinkDefault);
  }

  function setConv(st, conv) {
    st.conv = conv || null;
    st.byId = {};
    if (!conv) return;
    conv.messages.forEach((m) => { m.tools = m.tools || []; st.byId[m.id] = m; });
    // chat.done events that arrived before this view did.
    Object.keys(st.doneBuf || {}).forEach((mid) => { const m = st.byId[mid]; if (m) { applyDone(st, m, st.doneBuf[mid]); delete st.doneBuf[mid]; } });
  }

  /** The head's path from the root, oldest first. */
  function pathOf(conv) {
    if (!conv || !conv.messages.length) return [];
    const by = {}; conv.messages.forEach((m) => { by[m.id] = m; });
    let cur = by[conv.headId] || conv.messages[conv.messages.length - 1];
    const out = []; const seen = {};
    while (cur && !seen[cur.id]) { seen[cur.id] = true; out.unshift(cur); cur = cur.parentId ? by[cur.parentId] : null; }
    return out;
  }
  const siblingsOf = (conv, m) => conv.messages.filter((x) => x.parentId === m.parentId && x.role === m.role).sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  // 1.6.0 (B-8001): artifacts, from /api/conversations/:id/artifacts (owner, share reader) or the shared transcript.
  const artifactsOf = (st) => (st.sharedView ? st.sharedView.artifacts || [] : st.conv && st.artifactsFor === st.conv.id ? st.artifacts || [] : []);
  async function loadArtifacts(st) {
    const id = st.conv && st.conv.id; if (!id) return;
    try { const r = await App.get(cUrl(id) + '/artifacts'); if (S() === st && st.conv && st.conv.id === id) { st.artifacts = r.artifacts || []; st.artifactsFor = id; } } catch (err) { st.artifacts = []; st.artifactsFor = id; }
  }
  const headAnswer = (st) => { const p = pathOf(st.conv); const last = p[p.length - 1]; return last && last.role === 'assistant' ? last : null; };

  // ---------- socket ----------
  const live = { sock: null, handlers: null, timer: null, poll: null, ctx: null };
  function detach() {
    if (live.sock && live.handlers) Object.keys(live.handlers).forEach((ev) => live.sock.off(ev, live.handlers[ev]));
    live.sock = null; live.handlers = null;
    if (live.timer) { clearTimeout(live.timer); live.timer = null; }
  }
  function attach() {
    if (!App.socket || live.sock === App.socket) return;
    detach();
    live.sock = App.socket;
    const guard = (fn) => (d) => { if (!visible()) { detach(); return; } fn(S(), d || {}); };
    live.handlers = {
      'chat.status': guard(onStatus), 'chat.chunk': guard(onChunk), 'chat.done': guard(onDone), 'chat.released': guard(onReleased),
      'attachment.state': guard(onAttachment), connect: guard(onReconnect), 'shared.revoked': guard(onSharedRevoked),
      'chat.invocation': guard(onInvocation), 'run.step': guard(onRunEvent), 'run.state': guard(onRunEvent)
    };
    Object.keys(live.handlers).forEach((ev) => live.sock.on(ev, live.handlers[ev]));
  }
  window.addEventListener('hashchange', () => { if (App.parse().route !== 'chat') detach(); });

  function onStatus(st, d) {
    if (isShared(st, d)) { if (!sharedMsg(st, d.messageId)) sharedRefresh(st); return; }
    st.status = st.status || {};
    st.status[d.messageId] = Object.assign({}, st.status[d.messageId] || {}, d);
    if (d.state === 'fallback') { st.fallback = st.fallback || {}; st.fallback[d.messageId] = { from: d.from, profile: d.profile, model: d.model }; }
    if (d.state === 'context' && d.citations) { st.citeFor = st.citeFor || {}; st.citeFor[d.messageId] = true; }
    const m = byId(st, d.messageId);
    if (m && d.state === 'held') m.heldLive = true;
    if (m && d.state !== 'queued' && m.state === 'queued') m.state = 'streaming';
    if (m && d.profile) m.profile = d.profile;
    if (m && d.model) m.model = d.model;
    schedule();
  }
  function applyChunk(m, c) {
    if (c.seq <= m.seq) return true;
    if (c.seq !== m.seq + 1) return false;
    if (c.delta) m.content = (m.content || '') + c.delta;
    if (c.thinking) m.thinking = (m.thinking || '') + c.thinking;
    if (c.tool) m.tools.push(c.tool);
    m.seq = c.seq;
    if (m.state === 'queued') m.state = 'streaming';
    return true;
  }
  function onChunk(st, d) {
    if (isShared(st, d)) { sharedChunk(st, d); return; }
    if (!st.conv || d.conversationId !== st.conv.id) return;
    const m = byId(st, d.messageId);
    if (!m) return; // the conversation view that is loading includes it, and the next gap check catches up
    if (!applyChunk(m, d)) catchUp(m.id, false);
    schedule();
  }
  function applyDone(st, m, d) {
    m.state = d.state; m.usage = d.usage || m.usage; m.error = d.error || null;
    if (d.profile) m.profile = d.profile;
    if (d.model) m.model = d.model;
    if (!m.completedAt) m.completedAt = Date.now();
    if (st.status) delete st.status[m.id];
    if (d.seq > m.seq) catchUp(m.id, false);
  }
  function onDone(st, d) {
    if (isShared(st, d)) { sharedRefresh(st); return; }
    if (!st.conv || d.conversationId !== st.conv.id) { if (d.conversationId === st.convId) { st.doneBuf = st.doneBuf || {}; st.doneBuf[d.messageId] = d; } return; }
    const m = byId(st, d.messageId);
    if (!m) { st.doneBuf = st.doneBuf || {}; st.doneBuf[d.messageId] = d; return; }
    applyDone(st, m, d);
    if (d.state === 'complete' || d.state === 'stopped') loadArtifacts(st).then(schedule);
    // Citations (and a label raised by retrieval) are stored with the answer: reload the conversation to show them.
    if (st.citeFor && st.citeFor[d.messageId]) { delete st.citeFor[d.messageId]; loadConv(false).then(schedule); }
    if (d.state === 'failed') App.toast('<b>The answer failed</b> ' + esc(d.error || ''), 'danger', 6000);
    refreshProfiles();
    schedule();
  }
  /** A reviewer approved or rejected a held answer (or, since Sprint 16, a held question): read the conversation again. */
  function onReleased(st, d) {
    if (isShared(st, d)) { sharedRefresh(st); return; }
    if (!st.conv || d.conversationId !== st.conv.id) return;
    const m = byId(st, d.messageId);
    const question = !!d.answerId || (m && (m.role === 'user' || m.state === 'awaiting'));
    loadConv(false).then(schedule);
    if (question) { App.toast(d.state === 'withdrawn' ? 'A reviewer rejected your question. It was not sent to the model.' : 'A reviewer approved your question. The answer is being generated.', d.state === 'withdrawn' ? 'warn' : 'ok'); return; }
    App.toast(d.state === 'complete' ? 'An answer held for review was approved and is shown now.' : 'An answer held for review was withdrawn by the reviewer.', d.state === 'complete' ? 'ok' : 'warn');
  }
  function onAttachment(st, d) {
    const a = (st.pending || []).find((x) => x.id === d.id);
    if (!a) return;
    a.state = d.state;
    refreshAttachment(a);
    schedule();
  }
  function onReconnect(st) {
    if (st.sharedView && st.sharedLive) watchShared(st.sharedView.id);
    if (!st.conv) return;
    st.conv.messages.filter(active).forEach((m) => catchUp(m.id, true));
  }

  /** Fills a message from the stream endpoint: chunks after its last seq, or the stored answer once it is done. */
  async function catchUp(mid, marker) {
    const st = S();
    st.catching = st.catching || {};
    if (st.catching[mid]) { st.catching[mid] = 'again'; return; }
    const m = byId(st, mid); if (!m || !st.conv) return;
    st.catching[mid] = true;
    const from = m.seq;
    try {
      const r = await App.get(mUrl(st.conv.id, mid) + '/stream?after=' + m.seq);
      if (r.chunks) {
        r.chunks.slice().sort((a, b) => a.seq - b.seq).forEach((c) => applyChunk(m, c));
        m.state = r.state;
      } else {
        m.content = r.content || ''; m.thinking = r.thinking || null; m.tools = r.tools || [];
        m.usage = r.usage || null; m.error = r.error || null; m.seq = r.seq; m.state = r.state;
        if (st.status) delete st.status[mid];
      }
      if (marker) { st.resumed = st.resumed || {}; st.resumed[mid] = { at: from, to: r.seq }; }
    } catch (err) {
      if (err.status !== 404) App.fail(err, 'Could not catch up on the answer');
    } finally {
      const again = st.catching[mid] === 'again';
      delete st.catching[mid];
      schedule();
      if (again) catchUp(mid, false);
    }
  }

  // ---------- painting ----------
  // Streaming updates repaint only the thread, attachment chips, send bar and inspector, at most every 50 ms,
  // so the composer keeps its text, focus and caret and open dialogs stay open.
  function schedule() {
    if (live.timer) return;
    live.timer = setTimeout(() => { live.timer = null; paint(); }, 50);
  }
  function paint() {
    if (!visible()) return;
    const st = S(); const main = document.getElementById('main'); if (!main) return;
    const scroller = main.querySelector('.ch-scroll');
    const near = scroller ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 90 : false;
    const set = (region, html) => { const el = main.querySelector('[data-region="' + region + '"]'); if (el && el.innerHTML !== html) el.innerHTML = html; };
    if (st.sharedView) set('sharedthread', sharedThreadHtml(st));
    set('thread', threadHtml(st));
    set('atts', attsHtml(st));
    set('actions', actionsHtml(st));
    set('side', sideHtml(st));
    set('cold', coldHtml(st));
    set('skills', skillChipsHtml(st));
    if (scroller && near) scroller.scrollTop = scroller.scrollHeight;
  }
  function rerender(focusComposer) {
    if (!visible() || !live.ctx) return;
    const st = S(); const a = document.activeElement;
    st.focus = !!focusComposer || !!(a && a.id === 'ch-composer');
    st.caret = a && a.id === 'ch-composer' ? [a.selectionStart, a.selectionEnd] : null;
    live.ctx.rerender();
  }

  // ---------- rendering ----------
  /** Paragraphs and code blocks; `[n]` markers that match a citation of the message become links to its source. */
  function richText(s, m) {
    const nums = {}; ((m && m.citations) || []).forEach((c) => { nums[c.n] = true; });
    const cite = (html) => html.replace(/\[(\d{1,2})\]/g, (m0, n) => (nums[n] ? '<a href="#" class="ch-cite" data-cite="' + n + '" data-mid="' + esc(m.id) + '">' + n + '</a>' : m0));
    return String(s || '').split('```').map((part, i) => {
      if (i % 2) return '<pre class="ch-code">' + esc(part.replace(/^[\w+.-]*\n/, '')) + '</pre>';
      return part.split(/\n{2,}/).filter((p) => p.trim()).map((p) => '<p>' + cite(esc(p.replace(/^\n+|\n+$/g, '')).replace(/\n/g, '<br>')) + '</p>').join('');
    }).join('');
  }
  function branchSwitch(conv, m) {
    const sibs = siblingsOf(conv, m); if (sibs.length < 2) return '';
    const i = sibs.indexOf(m);
    return '<span class="ch-branch">' + UI.iconbtn('chev', 'Previous branch', { cls: 'sm ghost', attrs: 'data-branch="' + (i > 0 ? esc(sibs[i - 1].id) : '') + '" style="transform:rotate(180deg)"' + (i > 0 ? '' : ' disabled') })
      + '<span class="num">' + (i + 1) + ' / ' + sibs.length + '</span>'
      + UI.iconbtn('chev', 'Next branch', { cls: 'sm ghost', attrs: 'data-branch="' + (i < sibs.length - 1 ? esc(sibs[i + 1].id) : '') + '"' + (i < sibs.length - 1 ? '' : ' disabled') }) + '</span>';
  }
  function msgAttachments(ids) {
    if (!ids || !ids.length) return '';
    return '<div class="ch-matts">' + ids.map((id) => {
      const a = attCache[id];
      if (!a) { attCache[id] = { loading: true }; App.get('/api/attachments/' + enc(id)).then((r) => { attCache[id] = r; schedule(); }).catch(() => { attCache[id] = { name: 'attachment', gone: true }; schedule(); }); }
      const name = a && a.name ? a.name : 'attachment';
      return '<span class="ch-mchip">' + UI.icon('attach', 12) + esc(name) + (a && a.label ? ' ' + UI.label(a.label, { sm: true }) : '') + '</span>';
    }).join('') + '</div>';
  }
  function statusLine(st, m) {
    const s = (st.status || {})[m.id] || {};
    if (m.state === 'queued') {
      if (s.state === 'loading') return UI.notice('<b>Model cold start.</b> Loading ' + esc(s.model || m.model || '') + (s.instance ? ' on ' + esc(s.instance) : '') + '. This may take a moment; the answer starts as soon as it is loaded.', 'info');
      return '<div class="ch-status">' + UI.icon('clock', 13) + ' Queued' + (s.position ? ', position ' + num(s.position) : '') + ' for ' + esc(s.profile || m.profile || '') + '</div>';
    }
    if (m.state !== 'streaming') return '';
    if (s.state === 'loading' && !m.content && !m.thinking) return UI.notice('<b>Model cold start.</b> Loading ' + esc(s.model || m.model || '') + (s.instance ? ' on ' + esc(s.instance) : '') + '. This may take a moment; the answer starts as soon as it is loaded.', 'info');
    if (m.thinking && !m.content) return '';
    return '<div class="ch-status">' + (m.content ? 'Answering' : 'Starting') + ' with ' + esc(m.profile || '') + '…</div>';
  }
  function usageLine(m) {
    const u = m.usage; const parts = [esc(m.profile || ''), '<span class="mono">' + esc(m.model || '') + '</span>'];
    if (m.think && m.think !== 'off') parts.push('thinking ' + esc(m.think));
    if (u) {
      parts.push(num(u.promptTokens) + ' in, ' + num(u.outputTokens) + ' out tokens');
      if (u.thinkingTokens) parts.push(num(u.thinkingTokens) + ' thinking');
      if (u.calcCalls) parts.push(u.calcCalls + (u.calcCalls === 1 ? ' calculation' : ' calculations'));
      if (u.firstTokenMs != null) parts.push('first token ' + ms(u.firstTokenMs));
      parts.push((u.gpuMs / 1000).toFixed(2) + ' GPU-s');
    }
    return parts.filter(Boolean).join(', ');
  }
  function toolsHtml(m) {
    if (!m.tools || !m.tools.length) return '';
    return '<div class="ch-calc"><div class="eyebrow">' + UI.icon('calc', 12) + ' Calculated exactly</div>' + m.tools.map((t) => '<div class="ch-calcrow"><span class="mono">' + esc(t.expression) + '</span>'
      + (t.error ? ' <span class="ch-err">' + esc(t.error) + '</span>'
        : t.result ? (t.result.exact ? ' = <b class="mono">' + esc(t.result.decimal) + '</b>' + (t.result.fraction && t.result.fraction !== t.result.decimal ? ' <span class="muted mono">(' + esc(t.result.fraction) + ')</span>' : '')
          : ' ≈ <b class="mono">' + esc(t.result.decimal) + '</b> <span class="muted">exactly <span class="mono">' + esc(t.result.fraction) + '</span></span>') : '')
      + (t.name !== 'calculate' ? ' <span class="muted">' + esc(t.name) + '</span>' : '') + '</div>').join('') + '<div class="muted" style="font-size:11px">Computed by the calculation worker, not by the model.</div></div>';
  }
  function aiHtml(st, conv, m) {
    if (m.turn === 'tool') return toolTurnHtml(st, conv, m);
    const streaming = active(m);
    const openDefault = streaming && !m.content;
    const open = st.openThink && st.openThink[m.id] !== undefined ? st.openThink[m.id] : openDefault;
    const fb = (st.fallback || {})[m.id];
    let h = '<div class="ch-msg ch-ai' + (m.turn ? ' ch-turn' : '') + '" data-mid="' + esc(m.id) + '">';
    if (m.turn === 'agent' || m.turn === 'workflow') { h += runCardHtml(st, conv, m); if (m.state === 'queued') return h + '<div class="ch-mactions">' + branchSwitch(conv, m) + '</div></div>'; }
    if (fb) h += UI.notice(esc(fb.from) + ' waited too long in the queue, so ' + esc(fb.profile) + ' (<span class="mono">' + esc(fb.model) + '</span>) is answering instead.', 'warn');
    h += statusLine(st, m);
    if (m.thinking) {
      const u = m.usage;
      h += '<button type="button" class="ch-thinkbar" data-think="' + esc(m.id) + '" aria-expanded="' + (open ? 'true' : 'false') + '"><span>' + UI.icon('brain', 13) + ' ' + (streaming && !m.content ? 'Thinking at level ' + esc(m.think || '') + '…' : 'Thinking' + (m.think ? ' at level ' + esc(m.think) : '') + (u && u.thinkingTokens ? ', ' + num(u.thinkingTokens) + ' tokens' : '')) + '</span><span>' + (open ? 'Hide' : 'Show') + '</span></button>'
        + (open ? '<div class="ch-trace">' + esc(m.thinking).replace(/\n/g, '<br>') + '</div>' : '');
    }
    h += toolsHtml(m);
    // A question held for review (Sprint 16): its answer waits, and says so; a rejection says it was not sent.
    if (m.state === 'awaiting') h += '<div class="ch-held" role="status">' + UI.icon('clock', 13) + ' <b>Waiting for review.</b> <span class="muted">A guardrail asked a reviewer to check your question before it goes to the model. The answer starts here once it is approved.</span></div>';
    const held = m.state === 'held' || (streaming && m.heldLive);
    if (held) h += '<div class="ch-held" role="status">' + UI.icon('clock', 13) + ' <b>Held for review.</b> <span class="muted">A guardrail asked a reviewer to check this answer. It appears here once approved' + (streaming ? '; the model is still finishing it.' : '.') + '</span></div>';
    if (!held && (m.content || streaming)) h += '<div class="ch-answer serif">' + richText(m.content, m) + (streaming ? '<span class="blink ch-caret">▍</span>' : '') + '</div>';
    if ((m.citations || []).length && !streaming) h += '<div class="ch-srcs"><div class="eyebrow">Sources</div>' + sourcesHtml(m, 'ch-src') + '</div>';
    if (!streaming) h += artifactChips(st, m.id);
    if (!streaming) h += proposedCardsHtml(st, m);
    const rs = (st.resumed || {})[m.id];
    if (rs) h += '<div class="ch-gap">' + UI.icon('refresh', 12) + ' Stream resumed after event ' + num(rs.at) + (rs.to > rs.at ? '; ' + num(rs.to - rs.at) + ' events caught up' : '') + ', no duplicate text.</div>';
    if (m.state === 'stopped') h += '<div class="ch-final">' + UI.pill('stopped', 'warn') + ' <span class="muted">Stopped. What was produced is kept and metered.</span></div>';
    if (m.state === 'interrupted') h += '<div class="ch-final">' + UI.pill('interrupted', 'warn') + ' <span class="muted">The server generating this answer stopped. What was produced is kept; continue it to generate the rest.</span></div>';
    if (m.state === 'withdrawn') h += '<div class="ch-final">' + UI.pill('withdrawn', 'danger') + ' <span class="muted">' + (/^Your question was not sent/.test(m.content || '') ? 'A reviewer rejected the question.' : 'A reviewer rejected this answer.') + '</span></div>';
    if (m.state === 'failed') h += UI.notice('<b>The answer failed.</b> ' + esc(m.error || 'No detail was recorded.'), 'danger');
    if (m.state === 'complete' && !m.content && !(m.tools || []).length) h += '<div class="ch-final muted">The model returned an empty answer.</div>';
    h += '<div class="ch-mactions">';
    if (streaming) h += UI.btn('Stop', { kind: 'ghost', size: 'xs', icon: 'stop', attrs: 'data-stop="' + esc(m.id) + '"' });
    else if (m.state === 'awaiting') h += '';
    else h += (m.state === 'held' ? '' : UI.iconbtn('copy', 'Copy answer', { cls: 'sm', attrs: 'data-cp="' + esc(m.id) + '"' })) + (App.can('chat:write') && App.can('inference:invoke') ? ((m.state === 'interrupted' || m.state === 'stopped') ? UI.btn('Continue', { kind: 'ghost', size: 'xs', icon: 'play', attrs: 'data-continue="' + esc(m.id) + '"' }) : '') + UI.iconbtn('refresh', 'Regenerate', { cls: 'sm', attrs: 'data-regen="' + esc(m.id) + '"' }) : '');
    h += branchSwitch(conv, m) + '<span class="right muted">' + usageLine(m) + '</span></div>';
    return h + '</div>';
  }
  function userHtml(st, conv, m) {
    const review = m.state === 'held' ? ' ' + UI.pill('waiting for review', 'warn') : m.state === 'withdrawn' ? ' ' + UI.pill('rejected', 'danger') : '';
    return '<div class="ch-msg ch-user" data-mid="' + esc(m.id) + '"><div class="ch-bubble">' + esc(m.content).replace(/\n/g, '<br>') + msgAttachments(m.attachments) + '</div>'
      + (review ? '<div class="ch-uact">' + review + '</div>' : '')
      + '<div class="ch-uact">' + branchSwitch(conv, m) + (App.can('chat:write') && App.can('inference:invoke') ? UI.iconbtn('edit', 'Edit as a new branch', { cls: 'sm ghost', attrs: 'data-edit="' + esc(m.id) + '"' }) : '') + UI.iconbtn('copy', 'Copy', { cls: 'sm ghost', attrs: 'data-cp="' + esc(m.id) + '"' }) + '</div></div>';
  }
  function threadHtml(st) {
    if (st.loadError) return UI.problem('Chat could not be loaded', st.loadError.message, st.loadError.problem && st.loadError.problem.trace_id);
    if (!st.loaded || st.convLoading) return UI.notice('Loading…', 'info');
    if (st.convError) return UI.problem('This conversation could not be opened', st.convError.message, st.convError.problem && st.convError.problem.trace_id);
    const conv = st.conv;
    if (!conv || !conv.messages.length) {
      return UI.empty('Start with a question', (st.profiles || []).length ? 'Pick a profile, attach a text file if it helps, and ask. Calculations are done exactly by the calculation worker when the profile allows it.' : 'No profile is published for your clearance yet. A profile admin publishes them under Profiles.');
    }
    return pathOf(conv).map((m) => (m.role === 'user' ? userHtml(st, conv, m) : aiHtml(st, conv, m))).join('') + pendingCardsHtml(st);
  }
  function attsHtml(st) {
    const list = st.pending || [];
    if (!list.length) return '';
    return '<div class="ch-atts">' + list.map((a) => {
      const tone = a.state === 'ready' ? 'ok' : a.state === 'rejected' || a.state === 'failed' ? 'danger' : a.state === 'scanning' ? 'info' : 'warn';
      return '<div class="ch-att ' + (tone === 'danger' ? 'bad' : '') + '"><span class="hstack gap6">' + UI.icon('attach', 12) + '<span class="mono">' + esc(a.name) + '</span>' + (a.size ? '<span class="muted">' + size(a.size) + '</span>' : '')
        + UI.pill(a.state === 'failed' ? 'upload failed' : a.state, tone) + (a.state === 'ready' && a.label ? UI.label(a.label, { sm: true }) : '')
        + UI.iconbtn('x', 'Remove ' + a.name, { cls: 'sm ghost', attrs: 'data-rmatt="' + esc(a.key) + '"' }) + '</span>'
        + (a.reason ? '<span class="ch-attwhy">' + esc(a.reason) + (a.findings && a.findings.detections ? ' Found: ' + esc(Object.keys(a.findings.detections).map((k) => k.replace(/_/g, ' ') + ' ' + a.findings.detections[k]).join(', ')) + '.' : '') + '</span>' : '') + '</div>';
    }).join('') + '</div>';
  }
  function blocker(st) {
    const list = st.pending || [];
    const bad = list.find((a) => a.state === 'rejected' || a.state === 'failed');
    if (bad) return 'Remove ' + bad.name + ' before sending; it was not accepted.';
    const wait = list.find((a) => a.state !== 'ready');
    if (wait) return 'Waiting for ' + wait.name + ' to be scanned and classified.';
    const head = headAnswer(st);
    if (active(head)) return 'The answer is still ' + head.state + '. Stop it or wait for it to finish.';
    return '';
  }
  function actionsHtml(st) {
    const canSend = App.can('chat:write') && App.can('inference:invoke');
    const block = blocker(st);
    const disabled = !canSend || !selProfile(st) || !!block || st.sending;
    return '<div class="hstack gap6">' + UI.iconbtn('attach', 'Attach a file', { attrs: 'data-attachbtn' + (canSend ? '' : ' disabled') }) + '</div>'
      + '<span class="muted ch-hint grow">' + esc(block || (canSend ? 'Enter sends, Shift+Enter adds a line.' : 'Your roles let you read conversations but not send messages.')) + '</span>'
      + UI.btn(st.sending ? 'Sending…' : 'Send', { kind: 'primary', icon: 'send', attrs: 'data-send', disabled });
  }
  function noticeHtml(st) {
    const n = st.notice; if (!n) return '';
    const p = n.problem || {};
    const close = UI.iconbtn('x', 'Dismiss', { cls: 'sm ghost', attrs: 'data-dismiss' });
    if (n.kind === 'quota') {
      const what = p.limit === 'gpu_seconds_per_month' ? 'GPU-seconds per month' : p.limit === 'tokens_per_day' ? 'tokens per day' : (p.limit || 'a usage limit');
      const reset = p.resets_at ? new Date(p.resets_at).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
      return UI.notice('<b>Over quota: ' + esc(what) + (p.scope ? ' for this ' + esc(p.scope) : '') + '.</b> ' + (p.detail ? esc(p.detail) : (p.max != null ? 'Used ' + num(p.used) + ' of ' + num(p.max) + '.' : '') + (p.raised_by ? ' ' + esc(p.raised_by.charAt(0).toUpperCase() + p.raised_by.slice(1)) + ' can raise it.' : '')) + (reset ? ' Resets ' + esc(reset) + '.' : '') + (n.example ? ' <span class="muted">(example)</span>' : ''), 'warn', close);
    }
    if (n.kind === 'forbidden' && p.ceiling === 'workspace') return UI.notice('<b>Above this workspace\'s ceiling.</b> ' + esc(p.detail || '') + ' Lower the label, or switch to a workspace whose ceiling allows it.', 'danger', close);
    if (n.kind === 'forbidden') return UI.notice('<b>' + (p.step === 'zone' ? 'Label above this profile' : 'Above your clearance') + '.</b> ' + esc(p.detail || '') + (p.step === 'zone' ? ' Pick a profile cleared for this label.' : ''), 'danger', close);
    return '';
  }
  function coldHtml(st) {
    const p = selProfile(st);
    if (!p || (p.residency !== 'cold' && !st.forceCold)) return '';
    return '<div class="ch-cold">' + UI.icon('clock', 14) + '<span class="grow"><b>' + esc(p.name) + '</b> uses <span class="mono">' + esc(p.model) + '</span>, which is not loaded on any instance' + (p.residency === 'cold' ? '' : ' in this example; right now it is loaded') + '. Model cold start: the first answer may take a moment while it loads. You can send now; the message queues.</span></div>';
  }
  /** 1.6.0 (B-8001): the chips under an answer for the artifact versions it produced. */
  // ---------- 1.7.0 (B-4001 to B-4009): tools, agents, skills and workflows from the composer ----------
  const cardsOf = (st) => (st.conv && st.cards && st.cards.id === st.conv.id ? st.cards.list : []) || [];
  const cardById = (st, id) => cardsOf(st).find((c) => c.id === id) || null;
  const cardByMessage = (st, mid) => cardsOf(st).find((c) => c.messageId === mid) || null;
  const CARD_TONE = { done: 'ok', awaiting: 'warn', held: 'info', running: 'info', denied: 'danger', expired: 'outline', failed: 'danger', cancelled: 'outline' };
  const sidePill = (side) => (side ? UI.pill(side, side === 'read' ? 'outline' : side === 'write' ? 'warn' : 'danger') : '');
  const argsText = (args) => (args && typeof args === 'object' ? Object.keys(args).map((k) => k + '=' + JSON.stringify(args[k])).join('  ') : '');
  async function loadCards(st) {
    const id = st.convId; if (!id) { st.cards = null; return; }
    try { const list = await App.get(cUrl(id) + '/invocations'); if (S() === st && st.convId === id) st.cards = { id, list }; } catch (err) { if (S() === st) st.cards = { id, list: [] }; }
  }
  async function loadCaps(st) {
    const id = st.convId; if (!id) { st.caps = null; return; }
    try { const caps = await App.get(cUrl(id) + '/capabilities'); if (S() === st && st.convId === id) st.caps = { id, caps }; } catch (err) { if (S() === st) st.caps = { id, caps: null, error: err }; }
  }
  async function loadRun(st, runId) {
    st.runViews = st.runViews || {};
    try { const v = await App.get('/api/runs/' + enc(runId)); st.runViews[runId] = v; } catch (err) { st.runViews[runId] = { error: err }; }
  }
  /** A card's own events: a decision, a run ending, a reviewer's call. Cards and the thread are read again. */
  function onInvocation(st, d) {
    if (!st.conv || d.conversationId !== st.conv.id) return;
    Promise.all([loadCards(st), d.messageId ? loadConv(false) : Promise.resolve()]).then(() => { if (d.state === 'done' && d.kind === 'tool') App.toast(esc(d.name) + ' ran; its result is in the conversation.', 'ok'); schedule(); });
  }
  function onRunEvent(st, d) {
    if (!st.conv || !d || !d.runId) return;
    const card = cardsOf(st).find((c) => c.run && c.run.id === d.runId);
    if (!card) return;
    loadRun(st, d.runId).then(schedule);
  }
  /** B-4002: a tool turn: the call and its result (or why it did not run), as the model sees it next. */
  function toolTurnHtml(st, conv, m) {
    const card = m.invocationId ? cardById(st, m.invocationId) : null;
    const t = (m.tools || [])[0] || { name: m.profile || 'tool', expression: '' };
    const state = card ? card.state : t.error ? 'failed' : 'done';
    let args = t.expression; try { args = argsText(JSON.parse(t.expression)); } catch (e) { /* free text */ }
    let h = '<div class="ch-msg ch-ai ch-turn" data-mid="' + esc(m.id) + '"><div class="ch-card ' + esc(state) + '" data-card="' + esc(card ? card.id : '') + '"><div class="hstack gap6 wrap">' + UI.icon('tools', 13) + '<b>' + esc(t.name) + '</b>' + sidePill(card && card.sideEffect) + UI.pill(state, CARD_TONE[state] || '') + '<span class="muted" style="font-size:12px">' + (card && card.proposedBy === 'model' ? 'proposed by the model' : 'called by you') + (card && card.decidedBy ? ', decided' : '') + '</span></div>'
      + (args ? '<div class="mono fg2 ch-args">' + esc(args) + '</div>' : '');
    if (t.error) h += '<div class="ch-err" style="font-size:13px">' + esc(t.error) + '</div>';
    else h += '<div class="eyebrow">Result</div>' + UI.code(typeof t.output === 'string' ? t.output : JSON.stringify(t.output != null ? t.output : t.result, null, 2), 'json') + '<div class="muted" style="font-size:11px">The model sees this call and its result on the next turn.</div>';
    h += '</div>' + branchSwitch(conv, m) + '</div>';
    return h;
  }
  /** B-4004, B-4009: a run card for an agent or workflow turn: its state and steps while it works, the answer when done. */
  function runCardHtml(st, conv, m) {
    const card = m.invocationId ? cardById(st, m.invocationId) : null;
    const run = card && card.run ? card.run : null;
    const rv = run && st.runViews ? st.runViews[run.id] : null;
    const state = m.state === 'queued' ? (card ? card.state : 'running') : m.state === 'complete' ? 'done' : m.state === 'stopped' ? 'cancelled' : 'failed';
    const kind = m.turn === 'agent' ? 'Agent' : 'Workflow';
    let h = '<div class="ch-card ' + esc(state) + '" data-card="' + esc(card ? card.id : '') + '"><div class="hstack gap6 wrap">' + UI.icon(m.turn === 'agent' ? 'agents' : 'workflows', 13) + '<b>' + esc(m.profile || '') + '</b>' + UI.pill(kind.toLowerCase(), 'outline') + UI.pill(state === 'running' && card && card.runState ? card.runState : state, CARD_TONE[state] || '')
      + (run ? '<span class="muted" style="font-size:12px">run <a href="#/runs?run=' + esc(run.id) + '" class="mono" data-gorun="' + esc(run.id) + '">' + esc(run.id.slice(-6)) + '</a>' + (card.chain ? ' · <a href="#/runs?chain=' + esc(card.chain) + '" data-gochain="' + esc(card.chain) + '">chain tree</a>' : '') + '</span>' : '') + '</div>';
    if (m.state === 'queued') {
      if (rv && rv.steps) h += '<div class="ch-steps">' + rv.steps.map((s) => '<div class="ch-step ' + esc(s.state) + '"><span class="num">' + s.n + '</span><span>' + esc(s.title) + '</span><span class="muted">' + esc(s.lane) + (s.state === 'waiting' ? ', waiting for approval' : s.state === 'ok' ? '' : ', ' + esc(s.state)) + '</span></div>').join('') + '</div>';
      else if (run && m.turn === 'agent') h += '<div class="muted" style="font-size:12px">Starting…</div>';
      if (card && (card.approvals || []).length) h += card.approvals.map((a) => '<div class="ch-approval"><div class="hstack gap6"><b>Approval: ' + esc(a.step || '') + '</b>' + (a.role ? UI.pill(a.role, 'outline') : '') + '</div>' + (a.show ? '<div class="fg2" style="font-size:12px">' + esc(typeof a.show === 'string' ? a.show : JSON.stringify(a.show)) + '</div>' : '') + (a.canDecide !== false && App.can('chat:write') ? '<div class="hstack gap6">' + UI.btn('Approve', { kind: 'primary', size: 'sm', attrs: 'data-wfapprove="' + esc(a.id) + '"' }) + UI.btn('Reject', { kind: 'ghost', size: 'sm', attrs: 'data-wfreject="' + esc(a.id) + '"' }) + '</div>' : '') + '</div>').join('');
      if (card && (card.held || []).length) h += '<div class="ch-approval"><b>' + card.held.length + ' call' + (card.held.length === 1 ? '' : 's') + ' held in this chain</b><div class="fg2" style="font-size:12px">' + card.held.map((x) => esc(x.callee || x.tool || x.kind || 'call') + (x.path ? ' (' + esc(Array.isArray(x.path) ? x.path.join(' › ') : x.path) + ')' : '')).join(', ') + '. ' + (card.chain ? 'Decide from the <a href="#/runs?chain=' + esc(card.chain) + '" data-gochain="' + esc(card.chain) + '">chain tree</a>.' : '') + '</div></div>';
      if (App.can('chat:write') && card && card.state === 'running') h += '<div class="hstack gap6">' + UI.btn('Cancel ' + (m.turn === 'agent' ? 'run' : 'workflow'), { kind: 'ghost', size: 'sm', attrs: 'data-cancelrun="' + esc(card.id) + '"' }) + '<span class="muted" style="font-size:12px">' + (m.turn === 'agent' ? 'Budgets, approvals and cancel as in Runs. The answer lands here, attributed to the agent.' : 'Its approvals are decided here; its outcome lands here.') + '</span></div>';
    } else if (m.state === 'failed') h += UI.notice('<b>' + esc(kind) + ' run failed.</b> ' + esc(m.error || ''), 'danger');
    else if (m.state === 'stopped') h += '<div class="fg2" style="font-size:13px">Cancelled from the chat' + (m.error ? ': ' + esc(m.error) : '.') + '</div>';
    return h + '</div>';
  }
  /** B-4003: a card the model proposed during this answer, under it, with the owner's decision. */
  function proposedCardsHtml(st, m) {
    return cardsOf(st).filter((c) => c.answerId === m.id && c.kind === 'tool' && !c.messageId).map(pendingCardHtml).join('');
  }
  /** B-4002, B-4003: cards a person called that have not run yet (awaiting, held, expired) show after the thread. */
  function pendingCardsHtml(st) {
    const list = cardsOf(st).filter((c) => c.kind === 'tool' && !c.messageId && !c.answerId);
    return list.length ? '<div class="ch-msg ch-ai ch-turn ch-pending">' + list.map(pendingCardHtml).join('') + '</div>' : '';
  }
  function pendingCardHtml(c) {
    return [c].map((c) => '<div class="ch-card ' + esc(c.state) + '" data-card="' + esc(c.id) + '"><div class="hstack gap6 wrap">' + UI.icon('tools', 13) + '<b>' + esc(c.name) + '</b>' + sidePill(c.sideEffect) + UI.pill(c.state, CARD_TONE[c.state] || '') + '<span class="muted" style="font-size:12px">' + (c.proposedBy === 'model' ? 'proposed by the model' : 'called by you') + '</span></div>'
      + (c.arguments ? '<div class="mono fg2 ch-args">' + esc(argsText(c.arguments)) + '</div>' : '')
      + (c.state === 'awaiting' ? '<div class="fg2" style="font-size:12px">' + (c.approval === 'owner+reviewer' ? 'A destructive or always-confirm tool a rule flagged: your approval first, then the guardrail\'s approver in the Flags queue.' : 'A write tool runs only on your approval. It acts as you and is audited.') + (c.expiresAt ? ' Expires ' + esc(ago(c.expiresAt).replace(' ago', '')) + (Date.now() > c.expiresAt ? ' (past)' : ' from now') : '') + '.</div>' + (App.can('chat:write') ? '<div class="hstack gap6">' + UI.btn('Approve', { kind: 'primary', size: 'sm', attrs: 'data-approve="' + esc(c.id) + '"' }) + UI.btn('Deny', { kind: 'ghost', size: 'sm', attrs: 'data-deny="' + esc(c.id) + '"' }) + '</div>' : '')
        : c.state === 'held' ? '<div class="fg2" style="font-size:12px">' + UI.icon('clock', 12) + ' Held by the tool-call guardrail. It runs when a reviewer approves it in the Flags queue.</div>'
          : c.state === 'expired' ? '<div class="fg2" style="font-size:12px">The card expired before it was decided. Nothing ran.</div>' : c.error ? '<div class="fg2" style="font-size:12px">' + esc(c.error) + '</div>' : '')
      + '</div>').join('');
  }
  /** B-4005: the skills on the conversation, as chips with their mode. */
  function skillChipsHtml(st) {
    const on = st.conv ? st.conv.skills || [] : [];
    if (!on.length) return '';
    return '<span class="muted" style="font-size:12px">Skills:</span>' + on.map((s) => UI.chip(UI.icon('skills', 11) + ' ' + esc(s.name) + ' <span class="muted">' + (s.mode === 'once' ? 'this turn' : 'sticky') + '</span>' + (App.can('chat:write') ? '<span class="ch-x" aria-hidden="true">×</span>' : ''), true, 'data-rmskill="' + esc(s.name) + '" aria-label="Remove skill ' + esc(s.name) + '"')).join('');
  }
  /** B-4007, B-4008: the picker's items for "/", "@" and "+", from the conversation's capabilities. */
  function pickerItems(st) {
    const caps = st.caps && st.caps.caps; const q = ((st.picker && st.picker.q) || '').toLowerCase(); const hit = (x) => !q || x.name.toLowerCase().indexOf(q) >= 0;
    if (!caps || !st.picker) return [];
    if (st.picker.key === '/') return caps.tools.filter(hit).map((t) => ({ kind: 'tool', name: t.name, desc: t.description || '', side: t.sideEffect, confirm: t.confirm, schema: t.inputSchema })).concat(caps.workflows.filter(hit).map((w) => ({ kind: 'workflow', name: w.name, id: w.id, desc: w.description || '', schema: w.inputSchema })));
    if (st.picker.key === '@') return caps.agents.filter(hit).map((a) => ({ kind: 'agent', name: a.name, desc: (a.description || '') + (a.offeredToModel ? ' Also offered to the model.' : '') }));
    return caps.skills.filter(hit).map((s) => ({ kind: 'skill', name: s.name, desc: s.description || '', active: s.active }));
  }
  function pickerHtml(st) {
    if (!st.picker) return '';
    const caps = st.caps && st.caps.caps;
    if (!caps) return '<div class="dropdown ch-picker" role="status"><div class="dh">' + (st.caps && st.caps.error ? 'Could not load what this conversation may call.' : 'Loading…') + '</div></div>';
    const items = pickerItems(st);
    const title = st.picker.key === '/' ? 'Tools and workflows this conversation may call' : st.picker.key === '@' ? 'Agents you may start here' : 'Skills to add';
    const prefix = st.picker.key === '@' ? 'agent:' : st.picker.key === '+' ? 'skill:' : null;
    const hidden = (caps.hidden || []).filter((h) => (prefix ? h.name.indexOf(prefix) === 0 : h.name.indexOf('agent:') !== 0 && h.name.indexOf('skill:') !== 0));
    return '<div class="dropdown ch-picker" role="listbox" id="ch-picker" aria-label="' + esc(title) + '"><div class="dh"><span>' + esc(title) + '</span><span class="muted">↑↓ Enter Esc</span></div>'
      + (items.length ? items.map((it, i) => '<button type="button" role="option" id="ch-pick-' + i + '" aria-selected="' + (i === st.picker.i ? 'true' : 'false') + '" class="' + (i === st.picker.i ? 'on' : '') + '" data-pickitem="' + i + '">' + (it.side ? '<span class="side">' + sidePill(it.side) + '</span>' : it.kind === 'workflow' ? '<span class="side">' + UI.pill('workflow', 'outline') + '</span>' : it.active ? '<span class="side">' + UI.pill(it.active === 'once' ? 'this turn' : 'on', 'ok') + '</span>' : '') + esc(it.name) + (it.desc ? '<span class="desc">' + esc(it.desc) + '</span>' : '') + '</button>').join('') : '<div class="muted" style="padding:8px 12px;font-size:12px">Nothing matches.</div>')
      + (hidden.length ? '<div class="muted" style="padding:6px 12px;font-size:11px;border-top:1px solid var(--line)">Not listed: ' + hidden.map((h) => esc(h.name.replace(/^(agent|skill|workflow):/, '')) + ' (' + esc(h.reason) + ')').join('; ') + '</div>' : '') + '</div>';
  }
  function paintPicker(st) { const host = document.querySelector('[data-region="picker"]'); if (host) host.innerHTML = pickerHtml(st); const ta = document.getElementById('ch-composer'); if (ta) { if (st.picker && st.caps && st.caps.caps) { ta.setAttribute('aria-expanded', 'true'); ta.setAttribute('aria-controls', 'ch-picker'); ta.setAttribute('aria-activedescendant', 'ch-pick-' + st.picker.i); } else { ta.setAttribute('aria-expanded', 'false'); ta.removeAttribute('aria-controls'); ta.removeAttribute('aria-activedescendant'); } } }
  function closePicker(st) { st.picker = null; paintPicker(st); }
  /** The form for a tool's or a workflow's input schema: one field per property, required ones marked. */
  function schemaForm(schema) {
    const props = (schema && schema.properties) || {}; const req = (schema && schema.required) || [];
    const keys = Object.keys(props);
    if (!keys.length) return '<div class="muted" style="font-size:12px">No arguments.</div>';
    return keys.map((k) => { const p = props[k] || {}; const type = p.type === 'number' || p.type === 'integer' ? 'number' : 'text'; return UI.field(esc(k) + (req.indexOf(k) >= 0 ? ' *' : ''), p.enum ? UI.select(p.enum.map((v) => ({ value: String(v), label: String(v) })), String(p.enum[0]), 'data-arg="' + esc(k) + '" data-type="' + esc(p.type || 'string') + '" aria-label="' + esc(k) + '"') : UI.input('', { type, placeholder: p.description || '', attrs: 'data-arg="' + esc(k) + '" data-type="' + esc(p.type || 'string') + '" aria-label="' + esc(k) + '"' }), p.description && !p.enum ? '' : undefined); }).join('');
  }
  function readForm(root) {
    const out = {}; let any = false;
    root.querySelectorAll('[data-arg]').forEach((el) => { const v = el.value; if (v === '' || v == null) return; any = true; const t = el.dataset.type; out[el.dataset.arg] = t === 'number' || t === 'integer' ? Number(v) : t === 'boolean' ? v === 'true' : t === 'object' || t === 'array' ? (function () { try { return JSON.parse(v); } catch (e) { return v; } })() : v; });
    return any ? out : null;
  }
  function pickItem(ctx, st, it) {
    closePicker(st);
    const ta = ctx.$('#ch-composer');
    if (it.kind === 'skill') { if (ta) { ta.value = ''; st.draft = ''; } addSkill(st, it.name, 'sticky'); return; }
    if (it.kind === 'agent') { if (ta) { ta.value = '@' + it.name + ': '; st.draft = ta.value; ta.focus(); } App.toast('Say what ' + esc(it.name) + ' should do. Enter starts a run bound to this conversation.'); return; }
    if (ta) { ta.value = ''; st.draft = ''; }
    const isTool = it.kind === 'tool';
    ctx.modal({
      title: (isTool ? 'Call ' : 'Start ') + esc(it.name),
      body: '<div class="vstack gap8">' + (it.desc ? '<div class="fg2" style="font-size:13px">' + esc(it.desc) + '</div>' : '') + (it.side && it.side !== 'read' ? UI.notice('A ' + esc(it.side) + ' tool waits for your approval on a card before it runs' + (it.confirm === 'always' ? ', and for the guardrail\'s approver when a rule says so' : '') + '.', 'warn') : '') + '<form data-argform>' + schemaForm(it.schema) + '</form>' + (isTool ? UI.field('Or describe it', UI.textarea('', { rows: 2, placeholder: 'Free text the profile\'s model turns into arguments', attrs: 'data-text aria-label="Describe the call"' })) : '') + '</div>',
      actions: UI.btn('Cancel', { kind: 'ghost', attrs: 'data-close' }) + UI.btn(isTool ? 'Call' : 'Start', { kind: 'primary', attrs: 'data-go' }),
      onMount(d) {
        const go = async () => {
          const args = readForm(d); const text = (d.querySelector('[data-text]') || {}).value;
          try {
            if (isTool) { if (!args && !(text || '').trim()) { App.toast('Fill the form or describe the call.', 'warn'); return; } await App.post(cUrl(st.convId) + '/tool-calls', Object.assign({ name: it.name }, args ? { arguments: args } : { text: text.trim() })); }
            else await App.post(cUrl(st.convId) + '/workflow-runs', { workflow: it.id || it.name, input: args || {} });
            App.closeOverlay();
            await Promise.all([loadConv(false), loadCards(st)]); rerender(true);
          } catch (err) { handleError(err, isTool ? 'Could not call the tool' : 'Could not start the workflow'); }
        };
        d.querySelector('[data-go]').addEventListener('click', go);
        d.querySelector('[data-argform]').addEventListener('submit', (e) => { e.preventDefault(); go(); });
        const first = d.querySelector('[data-arg], [data-text]'); if (first) first.focus();
      }
    });
  }
  async function addSkill(st, name, mode) {
    try { await App.put(cUrl(st.convId) + '/skills', { name, mode }); await Promise.all([loadConv(false), loadCaps(st)]); rerender(true); App.toast('Skill ' + esc(name) + ' added' + (mode === 'once' ? ' for this turn' : ', sticky') + '. Its instructions join the system prompt from the next turn.', 'ok'); } catch (err) { handleError(err, 'Could not add the skill'); }
  }
  async function startAgent(st, agent, input) {
    try {
      const r = await App.post(cUrl(st.convId) + '/agent-runs', { agent, input, includeTurns: st.includeTurns !== false });
      st.draft = ''; const ta = document.getElementById('ch-composer'); if (ta) ta.value = '';
      await Promise.all([loadConv(false), loadCards(st)]); if (r.runId) loadRun(st, r.runId).then(schedule); rerender(true);
      App.toast('Run started for ' + esc(agent) + '. Its answer lands in this conversation.', 'ok');
    } catch (err) { handleError(err, 'Could not start the agent'); }
  }
  function artifactChips(st, messageId) {
    const chips = [];
    artifactsOf(st).forEach((a) => a.versions.forEach((v) => { if (v.messageId === messageId) chips.push(UI.chip(UI.icon(a.kind === 'html' ? 'images' : a.kind === 'document' ? 'knowledge' : 'scripts', 12) + ' ' + esc(a.key) + ' <span class="muted">v' + v.version + '</span>', !!(st.artifact && st.artifact.id === a.id && st.artifact.version === v.version), 'data-art="' + esc(a.id) + '" data-ver="' + v.version + '" aria-label="Open ' + esc(a.key) + ' version ' + v.version + '"')); }));
    return chips.length ? '<div class="ch-arts">' + chips.join('') + '</div>' : '';
  }
  /** The artifacts panel: the open artifact with its version switcher and sandboxed render, then the list. */
  function artifactsHtml(st) {
    const list = artifactsOf(st);
    if (!list.length) return '';
    let h = '<div class="ch-art"><div class="eyebrow">Artifacts</div>';
    const open = st.artifact ? list.find((a) => a.id === st.artifact.id) : null;
    if (open) {
      const v = open.versions.find((x) => x.version === st.artifact.version) || open.versions[open.versions.length - 1];
      const last = open.versions[open.versions.length - 1].version;
      h += '<div class="ahead"><b class="mono">' + esc(open.key) + '</b>' + UI.pill(open.kind, 'outline') + UI.label(open.label, { sm: true }) + '<span class="right">' + UI.iconbtn('chevron-left', 'Earlier version', { cls: 'sm', attrs: 'data-artprev' + (v.version === open.versions[0].version ? ' disabled' : '') })
        + UI.select(open.versions.map((x) => ({ value: String(x.version), label: 'v' + x.version })), String(v.version), 'data-artversion aria-label="Version of ' + esc(open.key) + '"') + UI.iconbtn('chevron-right', 'Later version', { cls: 'sm', attrs: 'data-artnext' + (v.version === last ? ' disabled' : '') }) + '</span></div>';
      if (open.kind === 'html') h += '<iframe sandbox="allow-scripts" referrerpolicy="no-referrer" title="' + esc(open.key) + ' version ' + v.version + '" src="' + esc(v.rawUrl) + '"></iframe>';
      else h += '<pre data-artbody>' + (st.artifactText && st.artifactText.id === v.id ? esc(st.artifactText.content) : '<span class="muted">Loading…</span>') + '</pre>';
      h += '<div class="hstack gap6"><span class="ch-artmeta">' + esc(String(v.bytes)) + ' bytes, version ' + v.version + ' of ' + last + (open.kind === 'html' ? ', rendered in a sandbox that cannot reach this page' : '') + '</span><span class="right hstack gap4">' + UI.btn('Copy', { size: 'sm', attrs: 'data-artcopy' }) + UI.btn('Open', { size: 'sm', kind: 'ghost', attrs: 'data-artopen' }) + UI.btn('Close', { kind: 'ghost', size: 'sm', attrs: 'data-artclose' }) + '</span></div>';
    }
    h += '<div class="alist">' + list.map((a) => UI.listItem(esc(a.key), a.versions.length + ' version' + (a.versions.length > 1 ? 's' : '') + ', ' + esc(a.kind), { active: !!(open && open.id === a.id), attrs: 'data-art="' + esc(a.id) + '" data-ver="' + a.versions[a.versions.length - 1].version + '"', right: '<span class="muted">v' + a.versions[a.versions.length - 1].version + '</span>' })).join('') + '</div></div>';
    return h;
  }
  /** Code and document artifacts are fetched as text (HTML ones render in the frame). */
  async function loadArtifactText(st) {
    const list = artifactsOf(st); const open = st.artifact ? list.find((a) => a.id === st.artifact.id) : null; if (!open || open.kind === 'html') return;
    const v = open.versions.find((x) => x.version === st.artifact.version) || open.versions[open.versions.length - 1];
    if (st.artifactText && st.artifactText.id === v.id) return;
    try {
      const r = st.sharedView ? await fetch(v.rawUrl, { credentials: 'omit' }).then((x) => { if (!x.ok) throw new Error('HTTP ' + x.status); return x.text(); }).then((content) => ({ content })) : await App.get(cUrl(st.conv.id) + '/artifacts/' + enc(open.id) + '/versions/' + v.version);
      st.artifactText = { id: v.id, content: r.content };
    } catch (err) { st.artifactText = { id: v.id, content: 'This version could not be loaded: ' + (err.message || 'error') }; }
    schedule();
  }
  function sideHtml(st) {
    const conv = st.conv; const p = selProfile(st);
    let h = artifactsHtml(st);
    if (conv) {
      const clearance = App.me && App.me.user ? App.me.user.clearance : 'public';
      const up = LABELS.filter((l) => rank(l) > rank(conv.label) && rank(l) <= rank(clearance));
      const kbNames = boundIds(st).map((id) => (kbOf(st, id) || { name: 'a knowledge base' }).name);
      h += '<div class="eyebrow">This conversation</div>' + UI.kv([['Label', UI.label(conv.label, { sm: true })], ['Knowledge', kbNames.length ? esc(kbNames.join(', ')) : 'none attached'], ['Messages', num(conv.messages.length)], ['Branches', num(conv.messages.filter((m) => !conv.messages.some((x) => x.parentId === m.id)).length)], ['Started', esc(ago(Number(conv.createdAt)))]], 2)
        + (up.length && App.can('chat:write') ? '<div class="hstack gap6">' + UI.select(up.map((l) => ({ value: l, label: l })), up[0], 'data-raiseto aria-label="New label"') + UI.btn('Raise label', { size: 'sm', attrs: 'data-raise' }) + '</div><div class="muted" style="font-size:12px">A label only goes up. Profiles below it can no longer answer here.</div>' : '');
      const last = headAnswer(st);
      if (last && (last.citations || []).length) h += '<div class="eyebrow">Sources</div><div class="vstack gap4">' + sourcesHtml(last, 'ch-isrc') + '</div>';
      if (last) {
        const u = last.usage;
        h += '<div class="eyebrow">Last answer</div>' + UI.kv([['Profile', App.can('profiles:manage') ? '<a href="#" data-goprofile="' + esc(last.profile || '') + '">' + esc(last.profile || '') + '</a>' : esc(last.profile || '')], ['Model', '<span class="mono">' + esc(last.model || '') + '</span>'], ['State', UI.pill(last.state, last.state === 'complete' ? 'ok' : last.state === 'failed' ? 'danger' : last.state === 'stopped' ? 'warn' : 'info')], ['Thinking', esc(last.think || 'off')]]
          .concat(u ? [['Tokens in', num(u.promptTokens)], ['Tokens out', num(u.outputTokens)], ['Thinking tokens', num(u.thinkingTokens)], ['Calculations', num(u.calcCalls)], ['First token', u.firstTokenMs == null ? '' : ms(u.firstTokenMs)], ['GPU-seconds', (u.gpuMs / 1000).toFixed(2)]] : []), 2);
      }
    }
    if (p) {
      h += '<div class="eyebrow">Selected profile</div>' + UI.kv([['Profile', esc(p.displayName || p.name) + (p.aliasOf ? ' <span class="muted">alias of ' + esc(p.aliasOf) + '</span>' : '')], ['Model', '<span class="mono">' + esc(p.model) + '</span>'], ['Residency', UI.pill(p.residency, p.residency === 'loaded' ? 'ok' : 'outline')], ['Handles up to', UI.label(p.label, { sm: true })], ['Thinking ceiling', esc(p.thinkCeiling)], ['Tools', p.tools && p.tools.length ? esc(p.tools.join(', ')) : 'none']], 2)
        + (p.description ? '<div class="fg2" style="font-size:12px">' + esc(p.description) + '</div>' : '') + (p.deprecated ? UI.notice('This profile\'s model is deprecated.', 'warn') : '');
    }
    return h || '<div class="muted" style="font-size:12px">Nothing selected.</div>';
  }
  function listHtml(st) {
    const q = (st.query || '').toLowerCase();
    const list = (st.convos || []).filter((c) => !q || (c.title || '').toLowerCase().indexOf(q) >= 0);
    if (!st.loaded) return st.loadError ? '' : '<div class="muted" style="font-size:12px;padding:6px">Loading…</div>';
    return list.map((c) => UI.listItem(esc(c.title || 'Untitled conversation'), esc(ago(c.updatedAt)), { active: c.id === st.convId, attrs: 'data-convo="' + esc(c.id) + '"', right: UI.label(c.label, { sm: true }) })).join('')
      + (list.length ? '' : UI.empty(q ? 'No conversations match' : st.archived ? 'No archived conversations' : 'No conversations yet', q ? 'Try another word or start a new conversation.' : st.archived ? 'Archived conversations show here.' : 'Ask something to start one in this workspace.'));
  }

  /** Keeps the open conversation in the address bar (so a reload reopens it) without a hashchange re-render. */
  function syncUrl(id) {
    const h = '#/chat' + (id ? '?id=' + enc(id) : '');
    if (!visible() || location.hash === h) return;
    try { history.replaceState(null, '', h); } catch (e) { return; }
    App.state.lastHash = location.hash; App.state.params = id ? { id } : {};
    S().paramId = id || null;
  }

  // ---------- data ----------
  const listReq = (st) => App.get('/api/conversations?kind=chat' + (st.archived ? '&archived=true' : ''));
  function load() {
    const st = S(); if (st.loading) return;
    st.loading = true;
    const wanted = st.convId;
    Promise.all([App.get('/api/chat/profiles'), listReq(st), wanted ? App.get(cUrl(wanted)).catch((err) => { if (err.status === 404) { st.convId = null; return null; } throw err; }) : null, App.can('knowledge:read') ? App.get('/api/knowledge/bases').catch(() => []) : []])
      .then(([profiles, convos, conv, kbs]) => {
        st.profiles = profiles; st.convos = convos; setConv(st, conv); st.convError = null; st.kbs = kbs;
        if (conv) loadBindings(conv.id);
        pickProfile(st, conv ? conv.profileId : null);
        st.loaded = true; st.loadError = null;
      })
      .catch((err) => { st.loadError = err; })
      .finally(() => {
        st.loading = false;
        if (!st.convId && App.state.params.id) { syncUrl(null); App.toast('That conversation is not in this workspace or no longer exists.', 'warn'); }
        rerender();
        if (st.conv) st.conv.messages.filter(active).forEach((m) => catchUp(m.id, true));
      });
  }
  /** Residency changes once a model has loaded; picked up after each answer. */
  function refreshProfiles() {
    const st = S();
    App.get('/api/chat/profiles').then((list) => { if (S() !== st) return; st.profiles = list; pickProfile(st, st.profile); schedule(); }).catch(() => { /* keeps the last list */ });
  }
  async function loadList() {
    const st = S();
    try { st.convos = await listReq(st); } catch (err) { App.fail(err, 'Could not list conversations'); }
  }
  /** Reloads the open conversation; `marker` shows "Stream resumed" for answers that were already running. */
  async function loadConv(marker) {
    const st = S(); const id = st.convId; if (!id) { setConv(st, null); return; }
    try {
      const conv = await App.get(cUrl(id));
      if (S() !== st || st.convId !== id) return;
      setConv(st, conv); st.convError = null;
      await Promise.all([loadArtifacts(st), loadCards(st)]);
      cardsOf(st).filter((c) => c.run && c.state === 'running' && c.run.kind === 'agent-run').forEach((c) => { if (!st.runViews || !st.runViews[c.run.id]) loadRun(st, c.run.id).then(schedule); });
    } catch (err) {
      if (err.status === 404) { st.convId = null; setConv(st, null); App.toast('That conversation no longer exists.', 'warn'); } else st.convError = err;
    }
    st.convLoading = false;
    if (st.conv) st.conv.messages.filter(active).forEach((m) => catchUp(m.id, marker));
  }
  async function openConv(id) {
    const st = S();
    if (st.convId === id && st.conv) return;
    st.convId = id; setConv(st, null); st.convLoading = true; st.notice = null; st.resumed = {}; st.forceCold = false; st.bound = null;
    syncUrl(id);
    loadBindings(id);
    rerender();
    await loadConv(true);
    if (st.conv) pickProfile(st, st.conv.profileId);
    rerender();
  }
  function handleError(err, what) {
    const st = S(); const p = (err && err.problem) || {};
    if (err && err.status === 429) { st.notice = { kind: 'quota', problem: p }; rerender(); return; }
    if (err && err.status === 403 && (p.step === 'clearance' || p.step === 'zone')) { st.notice = { kind: 'forbidden', problem: p }; rerender(); return; }
    if (err && err.status === 409) { App.toast('<b>' + esc(what || 'Not possible right now') + '</b> ' + esc(p.detail || err.message), 'warn', 6000); return; }
    App.fail(err, what);
  }

  async function send() {
    const st = S(); const ta = document.getElementById('ch-composer');
    const text = ((ta && ta.value) || '').trim();
    if (!text) { App.toast('Type a message first.'); return; }
    // 1.7.0 (B-4004): "@Agent: what to do" in an open conversation starts a run bound to it.
    const at = st.convId ? /^@([^:\n]{1,120}):\s*([\s\S]+)$/.exec(text) : null;
    if (at && App.can('agents:run')) { startAgent(st, at[1].trim(), at[2].trim()); return; }
    const p = selProfile(st); if (!p) { App.toast('No profile is available to answer.', 'warn'); return; }
    const block = blocker(st); if (block) { App.toast(esc(block), 'warn'); return; }
    if (st.sending) return;
    st.sending = true; paint();
    const body = { content: text, profile: p.name, think: st.think, attachments: (st.pending || []).map((a) => a.id) };
    let sent = null;
    try {
      const kbIds = st.newKbs || [];
      if (!st.convId && kbIds.length && App.can('context:write')) {
        // Attach the picked bases before the first message, so its answer already searches them.
        const c = await App.post('/api/conversations', {});
        try {
          await App.api('PUT', cUrl(c.id) + '/knowledge', { kbIds });
          sent = await App.post(cUrl(c.id) + '/messages', body);
        } catch (err) { await App.del(cUrl(c.id)).catch(() => undefined); throw err; }
        st.convId = c.id; st.bound = kbIds; st.newKbs = []; syncUrl(st.convId);
      } else if (!st.convId) {
        const r = await App.post('/api/chat', body); sent = r;
        st.convId = r.conversationId; st.bound = []; syncUrl(st.convId);
      } else {
        sent = await App.post(cUrl(st.convId) + '/messages', body);
      }
      if (sent && sent.state === 'awaiting') App.toast('<b>Your question is waiting for review.</b> ' + esc(sent.reason || '') + ' The answer starts when a reviewer approves it.', 'warn', 8000);
      st.draft = ''; if (ta) ta.value = '';
      st.pending = []; st.notice = null;
      await Promise.all([loadConv(false), loadList()]);
      st.sending = false;
      rerender(true);
    } catch (err) {
      st.sending = false; paint();
      handleError(err, 'Could not send');
    }
  }

  async function refreshAttachment(a) {
    try { Object.assign(a, await App.get('/api/attachments/' + enc(a.id))); attCache[a.id] = a; } catch (err) { /* the next event or poll retries */ }
    schedule();
  }
  function pollAttachments() {
    if (live.poll) return;
    live.poll = setInterval(() => {
      const st = S();
      const waiting = (st.pending || []).filter((a) => a.id && (a.state === 'quarantined' || a.state === 'scanning'));
      if (!waiting.length || !visible()) { clearInterval(live.poll); live.poll = null; return; }
      waiting.forEach(refreshAttachment);
    }, 1500);
  }
  async function upload(files) {
    const st = S(); st.pending = st.pending || [];
    const label = st.conv && rank(st.conv.label) > rank(newLabel()) ? st.conv.label : newLabel();
    for (const file of files) {
      const a = { key: 'k' + Math.random().toString(36).slice(2), name: file.name, size: file.size, state: 'uploading' };
      st.pending.push(a); paint();
      try {
        const res = await fetch('/api/attachments?name=' + enc(file.name) + '&label=' + enc(label), { method: 'PUT', body: file, credentials: 'same-origin', headers: { 'X-CSRF-Token': App.state.csrf || '', 'Content-Type': file.type || 'application/octet-stream', Accept: 'application/json' } });
        const data = /json/.test(res.headers.get('content-type') || '') ? await res.json() : null;
        if (!res.ok) { a.state = 'failed'; a.reason = (data && (data.detail || data.title)) || res.statusText; if (res.status === 401) App.sessionEnded('Your session ended. Sign in again.'); }
        else { Object.assign(a, data); attCache[a.id] = a; }
      } catch (e) { a.state = 'failed'; a.reason = 'The server could not be reached.'; }
      paint();
    }
    pollAttachments();
  }

  // ---------- modals ----------
  function profileOptions(st) { return (st.profiles || []).map((p) => ({ value: p.name, label: p.name + ' · ' + p.model + (p.residency === 'cold' ? ' (cold)' : '') + (p.deprecated ? ' (deprecated)' : '') })); }
  function regenerate(ctx, mid) {
    const st = S(); const m = byId(st, mid); if (!m) return;
    const start = profileOf(st, m.profile) || selProfile(st);
    if (!start) { App.toast('No profile is available to answer.', 'warn'); return; }
    const levelSel = (p, v) => UI.select(levelsFor(p), clampThink(p, v), 'data-rlevel');
    ctx.modal({
      title: 'Regenerate this answer',
      body: '<div class="fg2">A new answer to the same question, kept beside this one as a branch.</div>'
        + UI.field('Profile', UI.select(profileOptions(st), start.name, 'data-rprof'))
        + '<div data-rlevelhost>' + UI.field('Thinking', levelSel(start, m.think || start.thinkDefault)) + '</div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Regenerate', { kind: 'primary', icon: 'refresh', attrs: 'data-rgo' }),
      onMount(el) {
        const prof = el.querySelector('[data-rprof]');
        prof.addEventListener('change', () => { const p = profileOf(st, prof.value); el.querySelector('[data-rlevelhost]').innerHTML = UI.field('Thinking', levelSel(p, p.thinkDefault)); });
        el.querySelector('[data-rgo]').addEventListener('click', async (e) => {
          e.target.disabled = true;
          const think = el.querySelector('[data-rlevel]').value;
          try {
            await App.post(mUrl(st.conv.id, mid) + '/regenerate', { profile: prof.value, think });
            App.closeOverlay(); App.toast('Regenerating with ' + esc(prof.value) + '. The earlier answer stays as a branch.', 'ok');
            await loadConv(false); rerender();
          } catch (err) { e.target.disabled = false; App.closeOverlay(); handleError(err, 'Could not regenerate'); }
        });
      }
    });
  }
  function editMessage(ctx, mid) {
    const st = S(); const m = byId(st, mid); if (!m) return;
    ctx.modal({
      title: 'Edit and branch',
      body: UI.field('Message', UI.textarea(m.content, { rows: 6, attrs: 'data-etext' })) + UI.notice('Sending makes a new branch from this point with a fresh answer. The original question and its answers stay in the tree.', 'info'),
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Send as a new branch', { kind: 'primary', icon: 'send', attrs: 'data-ego' }),
      onMount(el) {
        const ta = el.querySelector('[data-etext]'); ta.focus();
        el.querySelector('[data-ego]').addEventListener('click', async (e) => {
          const content = ta.value.trim(); if (!content) { App.toast('The message is empty.'); return; }
          e.target.disabled = true;
          try {
            await App.post(mUrl(st.conv.id, mid) + '/edit', { content });
            App.closeOverlay(); App.toast('Sent as a new branch.', 'ok');
            await loadConv(false); rerender();
          } catch (err) { e.target.disabled = false; App.closeOverlay(); handleError(err, 'Could not send the edit'); }
        });
      }
    });
  }
  function rename(ctx) {
    const st = S(); const conv = st.conv; if (!conv) return;
    ctx.modal({
      title: 'Rename conversation',
      body: UI.field('Title', UI.input(conv.title || '', { attrs: 'data-rtitle maxlength="200"' })),
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Rename', { kind: 'primary', attrs: 'data-rok' }),
      onMount(el) {
        const inp = el.querySelector('[data-rtitle]'); inp.focus(); inp.select();
        const go = async () => {
          const title = inp.value.trim(); if (!title) { App.toast('A title cannot be empty.'); return; }
          try { await App.patch(cUrl(conv.id), { title }); App.closeOverlay(); App.toast('Renamed to ' + esc(title) + '.', 'ok'); await Promise.all([loadConv(false), loadList()]); rerender(); } catch (err) { App.fail(err, 'Could not rename'); }
        };
        el.querySelector('[data-rok]').addEventListener('click', go);
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
      }
    });
  }

  // ---------- Sprint 13: prompt library, sharing, export ----------
  // Shared conversations open read-only (/api/shared-conversations, or a link through /api/shared-links/open);
  // the prompt picker fills a published template (/api/prompts/:id/render) into the composer; exports run as jobs.
  function loadSharedList() {
    const st = S(); if (st.sharedLoading) return;
    st.sharedLoading = true;
    App.get('/api/shared-conversations').then((list) => { st.sharedList = list; }).catch(() => { st.sharedList = []; })
      .finally(() => { st.sharedLoading = false; const el = document.querySelector('#main [data-region="shared"]'); if (el && visible()) el.innerHTML = sharedListHtml(S()); });
  }
  function sharedListHtml(st) {
    const list = st.sharedList || [];
    if (!list.length) return '';
    return '<div class="eyebrow" style="padding:10px 8px 4px">Shared with you</div>' + list.map((c) => UI.listItem(esc(c.title || 'Untitled conversation'), esc('from ' + (c.owner || 'someone') + ', ' + ago(c.sharedAt)), { active: st.sharedView && st.sharedView.id === c.conversationId, attrs: 'data-sharedconv="' + esc(c.conversationId) + '"', right: UI.label(c.label, { sm: true }) })).join('');
  }
  // Live reading (Sprint 16): a reader asks the server to watch a conversation shared with them; the server checks the
  // share and decides the room. Answers stream in as the owner sees them (screened text, no thinking); revoking ends it.
  const isShared = (st, d) => !!(st.sharedView && st.sharedLive && d.conversationId === st.sharedView.id);
  const sharedMsg = (st, mid) => (st.sharedView ? st.sharedView.messages.find((m) => m.id === mid) : null);
  function watchShared(id) {
    const st = S();
    if (!App.socket) return;
    App.socket.emit('shared.watch', { conversationId: id }, (r) => { if (st.sharedView && st.sharedView.id === id) { st.sharedLive = !!(r && r.ok && !r.owner); schedule(); } });
  }
  function unwatchShared(st) {
    if (st.sharedView && st.sharedLive && App.socket) App.socket.emit('shared.unwatch', { conversationId: st.sharedView.id });
    st.sharedLive = false;
  }
  function sharedChunk(st, d) {
    const m = sharedMsg(st, d.messageId);
    if (!m) { sharedRefresh(st); return; }
    if (m.liveSeq == null || d.seq > m.liveSeq + 1) { sharedCatchUp(st, m); return; }
    if (d.seq <= m.liveSeq) return;
    if (d.delta) m.content = (m.content || '') + d.delta;
    if (d.tool) m.tools = (m.tools || []).concat([d.tool]);
    m.liveSeq = d.seq; m.state = 'streaming';
    schedule();
  }
  async function sharedCatchUp(st, m) {
    if (m.catching) return;
    m.catching = true;
    try {
      const r = await App.get('/api/shared-conversations/' + enc(st.sharedView.id) + '/messages/' + enc(m.id) + '/stream?after=' + (m.liveSeq || 0));
      if (r.chunks) r.chunks.forEach((c) => { if (m.liveSeq == null || c.seq === m.liveSeq + 1) { if (c.delta) m.content = (m.content || '') + c.delta; m.liveSeq = c.seq; } });
      else { m.content = r.content || ''; m.liveSeq = r.seq; }
      m.state = r.state || m.state;
    } catch (err) { /* the next event retries */ }
    m.catching = false;
    schedule();
  }
  function sharedRefresh(st) {
    if (st.sharedRefreshing || !st.sharedView) return;
    st.sharedRefreshing = true;
    const id = st.sharedView.id;
    App.get('/api/shared-conversations/' + enc(id)).then((v) => { if (st.sharedView && st.sharedView.id === id) st.sharedView = v; }).catch(() => undefined).finally(() => { st.sharedRefreshing = false; schedule(); });
  }
  function onSharedRevoked(st, d) {
    if (!st.sharedView || d.conversationId !== st.sharedView.id) return;
    st.sharedLive = false; st.sharedView = null;
    App.toast('The owner stopped sharing that conversation with you.', 'warn');
    loadSharedList(); rerender();
  }
  async function openShared(id) {
    const st = S();
    unwatchShared(st);
    try { st.sharedView = await App.get('/api/shared-conversations/' + enc(id)); st.sharedError = null; watchShared(id); } catch (err) { st.sharedView = null; st.sharedError = err; if (err.status === 404) { App.toast('That conversation is no longer shared with you.', 'warn'); loadSharedList(); } else App.fail(err, 'Could not open the shared conversation'); }
    rerender();
  }
  async function openLink(token) {
    const st = S();
    try { st.sharedView = await App.post('/api/shared-links/open', { token }); st.sharedError = null; } catch (err) { st.sharedView = null; st.sharedError = err; }
    rerender();
  }
  function sharedMsgsHtml(st, v) {
    return v.messages.map((m) => (m.role === 'user'
      ? '<div class="ch-msg ch-user"><div class="ch-bubble">' + esc(m.content).replace(/\n/g, '<br>') + '</div></div>'
      : '<div class="ch-msg ch-ai">' + (m.state === 'complete' || m.state === 'stopped' ? '<div class="ch-answer serif">' + richText(m.content, m) + '</div>'
        : st.sharedLive && (m.state === 'streaming' || m.state === 'queued') ? '<div class="ch-answer serif">' + (m.content ? richText(m.content, m) : '') + '<span class="blink ch-caret">▍</span></div><div class="ch-status">Answering live</div>'
          : '<div class="ch-final muted">This answer is ' + esc(m.state) + ' and is not shown.</div>')
        + ((m.citations || []).length ? '<div class="ch-srcs"><div class="eyebrow">Sources</div>' + (m.citations || []).map((c) => { const t = citeText(c); return '<div class="ch-src"><span class="n">' + esc(c.n) + '</span><span class="grow"><span class="t">' + esc(t.title) + '</span><span class="muted s">' + esc(t.sub) + '</span></span>' + (c.label ? UI.label(c.label, { sm: true }) : '') + '</div>'; }).join('') + '</div>' : '')
        + '<div class="ch-mactions"><span class="right muted">' + esc([m.profile, m.model].filter(Boolean).join(', ')) + '</span></div></div>')).join('');
  }
  function sharedPageHtml(st) {
    const v = st.sharedView;
    const head = '<div class="ch-head"><span class="t grow">' + esc(v.title || 'Untitled conversation') + '</span>' + UI.pill('read only', 'outline') + UI.label(v.label, { sm: true })
      + UI.btn('Export', { kind: 'ghost', size: 'sm', icon: 'download', attrs: 'data-export="' + esc(v.id) + '"' }) + UI.btn('Close', { kind: 'ghost', size: 'sm', attrs: 'data-closeshared' }) + '</div>';
    return '<div class="page tight ch-page">' + head + '<div class="ch-scroll"><div class="ch-thread" data-region="sharedthread">' + sharedThreadHtml(st) + '</div></div></div>';
  }
  function sharedThreadHtml(st) {
    const v = st.sharedView; if (!v) return '';
    const msgs = sharedMsgsHtml(st, v);
    return UI.notice('Shared by ' + esc(v.owner && v.owner.name ? v.owner.name : 'its owner') + '. You can read this conversation but not add to it' + (st.sharedLive ? '; new answers appear here as they are written' : '') + '. Access ends when the owner revokes it or its label rises above your clearance.', 'info')
      + (msgs || UI.empty('No messages', 'The conversation has no messages yet.')) + artifactsHtml(st);
  }

  function shareModal(ctx) {
    const st = S(); const conv = st.conv; if (!conv) return;
    const local = { kind: 'user', q: '', targets: null, shares: null };
    const shareRows = () => (local.shares || []).map((x) => '<tr><td>' + esc(x.kind === 'user' ? x.userName || 'a person' : x.kind === 'workspace' ? x.workspaceName || 'a workspace' : x.anonymous ? 'Link, no sign-in' : 'Link') + '</td><td>' + esc(x.kind) + '</td><td>' + UI.pill(x.state, x.state === 'active' ? 'ok' : 'outline') + '</td><td>' + esc(x.expiresAt ? new Date(x.expiresAt).toLocaleString() : 'no expiry') + '</td><td>' + (x.state === 'active' ? UI.btn('Revoke', { size: 'xs', kind: 'ghost', attrs: 'data-srevoke="' + esc(x.id) + '"' }) : '') + '</td></tr>').join('');
    const pickHtml = () => {
      if (local.kind === 'link') return UI.field('Link expires after', UI.select([{ value: '24', label: '1 day' }, { value: '72', label: '3 days' }, { value: '168', label: '7 days' }, { value: '720', label: '30 days' }], '168', 'data-sexp'))
        + (conv.label === 'public' ? '<label class="ch-pickrow"><input type="checkbox" data-sanon> <span class="grow">Anyone with the link, without signing in<span class="muted" style="display:block;font-size:11px">Only while the conversation stays public, and only if your tenant allows anonymous links. Every opening is recorded.</span></span></label>' : '')
        + '<div class="muted" style="font-size:12px">Anyone signed in to this tenant with the link and clearance for ' + esc(conv.label) + ' can read it. The link is shown once.</div>';
      const t = local.targets; if (!t) return '<div class="muted" style="font-size:12px">Loading…</div>';
      const list = local.kind === 'user' ? t.users : t.workspaces;
      return UI.search(local.kind === 'user' ? 'Search people' : 'Search workspaces', 'data-sq', local.q) + '<div class="ch-pick">' + (list.length ? list.map((x) => '<label class="ch-pickrow"><input type="radio" name="ch-target" value="' + esc(x.id) + '"' + (x.cleared ? '' : ' disabled') + '><span class="grow">' + esc(x.name) + (x.username ? ' <span class="mono muted">' + esc(x.username) + '</span>' : '') + '</span>' + (x.cleared ? '' : '<span class="muted" style="font-size:11px">' + (local.kind === 'user' ? 'below ' : 'ceiling below ') + esc(conv.label) + '</span>') + '</label>').join('') : '<div class="muted" style="padding:8px;font-size:12px">Nobody matches.</div>') + '</div>';
    };
    ctx.modal({
      title: 'Share this conversation', cls: 'wide',
      body: '<div class="fg2">Readers see the active branch and its sources, read only. Sharing stays inside this tenant and within the conversation\'s label (' + esc(conv.label) + ').</div>'
        + '<div data-sshares></div>' + UI.seg([{ id: 'user', label: 'A person' }, { id: 'workspace', label: 'A workspace' }, { id: 'link', label: 'A link' }], local.kind, 'data-skind') + '<div data-spick></div><div data-serr></div>',
      actions: UI.btn('Close', { attrs: 'data-close' }) + UI.btn('Share', { kind: 'primary', attrs: 'data-sgo' }),
      onMount(el) {
        const paintShares = () => { el.querySelector('[data-sshares]').innerHTML = local.shares && local.shares.length ? '<div class="tablewrap"><table class="dt"><thead><tr><th>With</th><th>Kind</th><th>State</th><th>Expires</th><th></th></tr></thead><tbody>' + shareRows() + '</tbody></table></div>' : '<div class="muted" style="font-size:12px">Not shared yet.</div>'; };
        const paintPick = () => { el.querySelector('[data-spick]').innerHTML = pickHtml(); const q = el.querySelector('[data-sq]'); if (q) { q.addEventListener('input', () => { local.q = q.value; loadTargets(); }); } };
        const loadShares = () => App.get(cUrl(conv.id) + '/shares').then((l) => { local.shares = l; paintShares(); }).catch((err) => App.fail(err, 'Could not list shares'));
        let timer = null;
        const loadTargets = () => { clearTimeout(timer); timer = setTimeout(() => App.get(cUrl(conv.id) + '/share-targets?q=' + enc(local.q)).then((t) => { local.targets = t; const had = el.querySelector('[data-sq]'); const pos = had ? had.selectionStart : null; paintPick(); const q = el.querySelector('[data-sq]'); if (q && had) { q.focus(); try { q.setSelectionRange(pos, pos); } catch (e) { /* ignore */ } } }).catch((err) => App.fail(err, 'Could not search')), local.targets ? 250 : 0); };
        paintShares(); paintPick(); loadShares(); loadTargets();
        el.querySelector('[data-skind]').addEventListener('click', (e) => { const b = e.target.closest('[data-seg]'); if (!b) return; local.kind = b.dataset.seg; el.querySelectorAll('[data-skind] [data-seg]').forEach((x) => { x.classList.toggle('active', x === b); x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); }); paintPick(); });
        el.addEventListener('click', async (e) => {
          const r = e.target.closest('[data-srevoke]'); if (!r) return;
          r.disabled = true;
          try { await App.del(cUrl(conv.id) + '/shares/' + enc(r.dataset.srevoke)); App.toast('Share revoked. The reader lost access at once.', 'ok'); loadShares(); } catch (err) { r.disabled = false; App.fail(err, 'Could not revoke'); }
        });
        el.querySelector('[data-sgo]').addEventListener('click', async (e) => {
          const box = el.querySelector('[data-serr]'); box.innerHTML = '';
          let body;
          if (local.kind === 'link') { const anon = el.querySelector('[data-sanon]'); body = { kind: 'link', expiresInHours: Number(el.querySelector('[data-sexp]').value), anonymous: !!(anon && anon.checked) }; }
          else {
            const picked = el.querySelector('input[name=ch-target]:checked');
            if (!picked) { box.innerHTML = UI.notice('Pick ' + (local.kind === 'user' ? 'a person' : 'a workspace') + ' first.', 'warn'); return; }
            body = local.kind === 'user' ? { kind: 'user', userId: picked.value } : { kind: 'workspace', workspaceId: picked.value };
          }
          e.target.disabled = true;
          try {
            const r = await App.post(cUrl(conv.id) + '/shares', body);
            e.target.disabled = false;
            if (r.url) box.innerHTML = UI.notice('<b>Copy the link now; it is not shown again.</b><div class="mono" style="overflow-wrap:anywhere;margin-top:6px">' + esc(r.url) + '</div>', 'ok', UI.btn('Copy', { size: 'sm', attrs: 'data-scopy' }));
            else App.toast('Shared with ' + esc(r.userName || r.workspaceName || 'them') + '. They can read it now.', 'ok');
            const cp = el.querySelector('[data-scopy]');
            if (cp) cp.addEventListener('click', () => { if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(r.url).then(() => App.toast('Link copied.'), () => App.toast('The browser refused clipboard access.', 'warn')); });
            loadShares();
          } catch (err) { e.target.disabled = false; const p = err.problem || {}; box.innerHTML = UI.notice('<b>' + esc(p.detail || err.message) + '</b>', 'danger'); }
        });
      }
    });
  }

  function exportModal(ctx, convId) {
    ctx.modal({
      title: 'Export conversation',
      body: '<div class="fg2">The active branch with its sources, as a file prepared in the background. Exports are checked by the export guardrail, stored sealed and audited; only you can download yours.</div>'
        + UI.field('Format', UI.select([{ value: 'markdown', label: 'Markdown (.md)' }, { value: 'json', label: 'JSON' }], 'markdown', 'data-xfmt')) + '<div data-xstate></div>',
      actions: UI.btn('Close', { attrs: 'data-close' }) + UI.btn('Export', { kind: 'primary', icon: 'download', attrs: 'data-xgo' }),
      onMount(el) {
        const box = el.querySelector('[data-xstate]');
        el.querySelector('[data-xgo]').addEventListener('click', async (e) => {
          e.target.disabled = true; box.innerHTML = UI.notice('Preparing the export…', 'info');
          try {
            let x = await App.post(cUrl(convId) + '/exports', { format: el.querySelector('[data-xfmt]').value });
            for (let i = 0; i < 60 && (x.state === 'queued' || x.state === 'running'); i++) {
              await new Promise((r) => setTimeout(r, 1000));
              x = await App.get('/api/conversation-exports/' + enc(x.id));
            }
            e.target.disabled = false;
            if (x.state === 'ready') box.innerHTML = UI.notice('<b>Ready.</b> ' + esc(x.file) + ', ' + size(x.bytes || 0) + ', labelled ' + esc(x.label) + '.', 'ok', '<a class="btn primary sm" href="/api/conversation-exports/' + enc(x.id) + '/download" download="' + esc(x.file) + '">Download</a>');
            else if (x.state === 'failed') box.innerHTML = UI.notice('<b>The export failed.</b> ' + esc(x.error || ''), 'danger');
            else box.innerHTML = UI.notice('Still being prepared. It stays available; try again in a moment.', 'warn');
          } catch (err) { e.target.disabled = false; const p = err.problem || {}; box.innerHTML = UI.notice('<b>' + esc(p.detail || err.message) + '</b>', 'danger'); }
        });
      }
    });
  }

  function promptPicker(ctx) {
    const local = { list: null, sel: null, detail: null, q: '' };
    ctx.modal({
      title: 'Insert a prompt', cls: 'wide',
      body: '<div class="fg2">Published templates of this tenant and your workspaces, up to your clearance. The filled text goes into the composer; you can still change it before sending.</div>' + UI.search('Search prompts', 'data-pq', '') + '<div class="ch-pick" data-plist></div><div data-pvars></div><div data-perr></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Insert', { kind: 'primary', attrs: 'data-pgo disabled' }),
      onMount(el) {
        const listEl = el.querySelector('[data-plist]'); const vars = el.querySelector('[data-pvars]'); const go = el.querySelector('[data-pgo]');
        const paintList = () => {
          const q = local.q.toLowerCase();
          const rows = (local.list || []).filter((t) => !q || (t.name + ' ' + (t.description || '')).toLowerCase().indexOf(q) >= 0);
          listEl.innerHTML = !local.list ? '<div class="muted" style="padding:8px;font-size:12px">Loading…</div>' : rows.length ? rows.map((t) => '<label class="ch-pickrow"><input type="radio" name="ch-prompt" value="' + esc(t.id) + '"' + (local.sel === t.id ? ' checked' : '') + '><span class="grow"><b>' + esc(t.name) + '</b>' + (t.description ? '<span class="muted" style="display:block;font-size:12px">' + esc(t.description) + '</span>' : '') + '</span>' + (t.state === 'deprecated' ? UI.pill('deprecated', 'warn') : '') + '<span class="muted" style="font-size:11px">' + esc(t.workspace || 'tenant') + ', v' + esc(t.publishedVersion) + '</span>' + UI.label(t.label, { sm: true }) + '</label>').join('') : '<div class="muted" style="padding:8px;font-size:12px">' + (local.list.length ? 'No prompt matches.' : 'No prompt is published for you yet.') + '</div>';
        };
        const paintVars = () => {
          const d = local.detail; if (!d) { vars.innerHTML = ''; go.disabled = true; return; }
          const v = d.versions.find((x) => x.version === d.publishedVersion) || d.versions[0];
          vars.innerHTML = '<div class="codebox mono" style="white-space:pre-wrap;font-size:12px;max-height:140px;overflow:auto">' + esc(v.body) + '</div>'
            + (v.variables.length ? '<div class="formgrid">' + v.variables.map((x) => UI.field(x.name + (x.description ? ', ' + x.description : ''), UI.input(x.default || '', { attrs: 'data-pvar="' + esc(x.name) + '"', placeholder: x.default ? '' : 'required' }))).join('') + '</div>' : '<div class="muted" style="font-size:12px">This template has no variables.</div>');
          go.disabled = false;
        };
        App.get('/api/prompts').then((r) => { local.list = r.templates; paintList(); }).catch((err) => { local.list = []; paintList(); App.fail(err, 'Could not list prompts'); });
        paintList();
        el.querySelector('[data-pq]').addEventListener('input', (e) => { local.q = e.target.value; paintList(); });
        listEl.addEventListener('change', async (e) => {
          const id = e.target.value; local.sel = id; local.detail = null; paintVars();
          try { const d = await App.get('/api/prompts/' + enc(id)); if (local.sel === id) { local.detail = d; paintVars(); } } catch (err) { App.fail(err, 'Could not open the prompt'); }
        });
        go.addEventListener('click', async () => {
          const d = local.detail; if (!d) return;
          const values = {}; el.querySelectorAll('[data-pvar]').forEach((i) => { if (i.value !== '') values[i.dataset.pvar] = i.value; });
          el.querySelector('[data-perr]').innerHTML = '';
          try {
            const r = await App.post('/api/prompts/' + enc(d.id) + '/render', { variables: values });
            const st = S(); st.draft = (st.draft ? st.draft.replace(/\s+$/, '') + '\n\n' : '') + r.text;
            App.closeOverlay(); rerender(true);
            App.toast('Inserted ' + esc(r.template.name) + ', version ' + esc(r.template.version) + '.', 'ok');
          } catch (err) { const p = err.problem || {}; el.querySelector('[data-perr]').innerHTML = UI.notice('<b>' + esc(p.detail || err.message) + '</b>', 'danger'); }
        });
      }
    });
  }

  App.register({
    id: 'chat', title: 'Chat', live: true,
    summary: 'Conversations with branches, streamed answers, thinking, exact calculation and attachments',
    crumb: (st) => (st.sharedView ? ['Chat', 'Shared with you', st.sharedView.title || 'Untitled conversation'] : null) || ['Chat', st.conv ? (st.conv.title || 'Untitled conversation') : st.convId ? 'Conversation' : 'New conversation'],
    label: (st) => (st.sharedView ? st.sharedView.label : st.conv ? st.conv.label : st.convId ? null : newLabel()),
    commands: [
      { label: 'New conversation', sub: 'Chat', run(app) { const st = app.stateFor('chat'); st.convId = null; st.conv = null; st.byId = {}; st.notice = null; st.pending = []; app.render(); setTimeout(() => { const c = document.getElementById('ch-composer'); if (c) c.focus(); }, 30); } }
    ],
    states: [
      { title: 'Chat', tone: 'neutral', text: 'The conversation as it is: the head branch, streamed answers and their usage.', apply(ctx) { Object.assign(ctx.state, { notice: null, forceCold: false, resumed: {} }); ctx.rerender(); } },
      { title: 'Model cold start', tone: 'neutral', text: 'The picked profile\'s model is not loaded. The composer stays usable and the message queues while it loads.', apply(ctx) {
        const st = ctx.state; const cold = (st.profiles || []).find((p) => p.residency === 'cold');
        if (cold) { st.profile = cold.name; st.think = cold.thinkDefault; st.forceCold = false; ctx.toast(esc(cold.name) + ' is cold: its model loads on the first message.'); } else st.forceCold = true;
        ctx.rerender();
      } },
      { title: 'Over quota', tone: 'warn', text: 'Sending is refused with 429. The notice names the limit, when it resets and who can raise it.', apply(ctx) {
        const st = ctx.state;
        if (!st.notice || st.notice.kind !== 'quota') {
          const t = new Date(); t.setUTCHours(24, 0, 0, 0);
          st.notice = { kind: 'quota', example: true, problem: { limit: 'tokens_per_day', scope: 'workspace', used: 500000, max: 500000, resets_at: t.toISOString(), raised_by: 'a tenant admin' } };
        }
        ctx.rerender();
      } },
      { title: 'Stream resumed', tone: 'info', text: 'The answer is caught up from the stream endpoint after a dropped connection, with no duplicate text. A quiet marker shows the gap.', apply(ctx) {
        const last = headAnswer(ctx.state);
        if (!last) { ctx.toast('Open a conversation with an answer first.'); return; }
        catchUp(last.id, true);
      } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      live.ctx = ctx;
      attach();
      const wantId = ctx.params.id || ctx.params.convo; // other screens link with ?convo=
      if (wantId && wantId !== st.paramId) { st.paramId = wantId; st.convId = wantId; setConv(st, null); st.loaded = false; }
      if (st.pending === undefined) st.pending = [];
      if (!st.loaded && !st.loadError) load();
      if (ctx.params.shared && ctx.params.shared !== st.sharedToken) { st.sharedToken = ctx.params.shared; st.sharedView = null; st.sharedError = null; openLink(ctx.params.shared); }
      if (st.sharedList === undefined && App.can('chat:read')) { st.sharedList = []; loadSharedList(); }
      const p = selProfile(st);
      const canSend = App.can('chat:write') && App.can('inference:invoke');
      const conv = st.conv;

      root.innerHTML = '<style>'
        + '.ch-list{display:flex;flex-direction:column;gap:2px}'
        + '.ch-page{display:flex;flex-direction:column;min-height:0}.ch-page>.ch-scroll{flex:1 1 auto;min-height:0;overflow:auto}'
        + '.ch-head{display:flex;align-items:center;gap:8px;padding:8px 16px;border-bottom:1px solid var(--line);min-height:44px}.ch-head .t{margin:0;font-size:inherit;line-height:inherit;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
        + '.ch-thread{display:flex;flex-direction:column;gap:14px;padding:20px 24px;max-width:760px;width:100%;margin:0 auto;box-sizing:border-box}'
        + '.ch-user{display:flex;flex-direction:column;align-items:flex-end;gap:4px}.ch-bubble{max-width:560px;padding:10px 14px;background:var(--bubble);border-radius:12px 12px 2px 12px;font-size:14px;overflow-wrap:anywhere}'
        + '.ch-uact{display:flex;align-items:center;gap:4px;opacity:.55}.ch-user:hover .ch-uact,.ch-uact:focus-within{opacity:1}'
        + '.ch-ai{display:flex;flex-direction:column;gap:10px;max-width:680px}'
        + '.ch-thinkbar{display:flex;justify-content:space-between;align-items:center;gap:8px;width:100%;padding:6px 10px;border:1px solid var(--line);border-radius:6px;background:var(--panel);font-size:12px;color:var(--fg2);cursor:pointer;font-family:inherit;text-align:left}.ch-thinkbar span{display:inline-flex;align-items:center;gap:6px}'
        + '.ch-trace{padding:10px 12px;border-left:2px solid var(--line);font-size:13px;color:var(--fg2);font-style:italic;overflow-wrap:anywhere;max-height:260px;overflow:auto}'
        + '.ch-answer{font-size:16px;line-height:1.55;overflow-wrap:anywhere}.ch-answer p{margin:0 0 10px}.ch-answer p:last-of-type{margin-bottom:0}'
        + '.ch-code{font-family:var(--mono,monospace);font-size:13px;background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:10px 12px;overflow:auto;white-space:pre;margin:0 0 10px}'
        + '.ch-calc{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:1px solid var(--line);border-radius:6px;background:var(--panel)}.ch-calc .eyebrow{display:inline-flex;align-items:center;gap:6px}.ch-calcrow{font-size:13px;overflow-wrap:anywhere}.ch-err{color:var(--danger-fg)}'
        + '.ch-status{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted)}'
        + '.ch-gap{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);border-top:1px dashed var(--line);padding-top:6px}'
        + '.ch-final{display:flex;align-items:center;gap:6px;font-size:12px}'
        + '.ch-mactions{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);flex-wrap:wrap}.ch-mactions .right{margin-left:auto;text-align:right}'
        + '.ch-branch{display:inline-flex;align-items:center;gap:2px;font-size:12px;color:var(--fg2)}'
        + '.ch-matts{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}.ch-mchip{display:inline-flex;align-items:center;gap:4px;font-size:12px;padding:2px 6px;border:1px solid var(--line);border-radius:10px;background:var(--panel)}'
        + '.ch-composer{border-top:1px solid var(--line);background:var(--bg);padding:12px 24px 16px}.ch-inner{max-width:760px;margin:0 auto;display:flex;flex-direction:column;gap:8px}'
        + '.ch-composer textarea{width:100%;box-sizing:border-box;min-height:64px;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--fg);font:inherit;font-size:14px;resize:vertical;line-height:1.4}'
        + '.ch-cold{display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--info-bg);color:var(--info-fg);font-size:12px;border-radius:6px}'
        + '.ch-atts{display:flex;flex-direction:column;gap:6px}.ch-att{display:flex;flex-direction:column;gap:2px;padding:6px 8px;border:1px solid var(--line);border-radius:6px;font-size:12px}.ch-att.bad{border-color:var(--danger-fg)}.ch-attwhy{color:var(--danger-fg)}'
        + '.ch-actions{display:flex;align-items:center;gap:12px}.ch-hint{font-size:12px}'
        + '.ch-answer .ch-cite{display:inline-block;margin-left:2px;font-size:11px;font-weight:700;vertical-align:super;text-decoration:none;font-family:var(--sans)}'
        + '.ch-arts{display:flex;flex-wrap:wrap;gap:4px}.ch-art{display:flex;flex-direction:column;gap:8px;margin-bottom:12px}.ch-art .ahead{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px}.ch-art .ahead .right{margin-left:auto;display:inline-flex;align-items:center;gap:4px}'
        + '.ch-art iframe{width:100%;height:320px;border:1px solid var(--line);border-radius:6px;background:var(--panel)}.ch-art pre{margin:0;max-height:360px;overflow:auto;padding:10px;border:1px solid var(--line);border-radius:6px;background:var(--panel2);font-family:var(--mono,monospace);font-size:12px;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere}'
        + '.ch-art .alist{display:flex;flex-direction:column;gap:2px}.ch-artmeta{font-size:12px;color:var(--muted)}'
        + '.ch-held{padding:10px 12px;border:1px dashed var(--line);border-radius:8px;background:var(--panel);font-size:13px}.ch-pass{display:block;margin-top:2px;color:var(--fg2);font-style:italic}.ch-quote{margin:0;padding:8px 12px;border-left:3px solid var(--accent);background:var(--panel);font-size:14px}'
        + '.ch-srcs{display:flex;flex-direction:column;gap:4px}.ch-src,.ch-isrc{display:flex;gap:8px;align-items:flex-start;width:100%;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--panel);color:var(--fg);font:inherit;font-size:12px;text-align:left;cursor:pointer}.ch-isrc{border-color:transparent;background:none}'
        + '.ch-src:hover,.ch-isrc:hover,.ch-src.hi,.ch-isrc.hi{background:var(--accent-tint)}.ch-src .n,.ch-isrc .n{width:18px;height:18px;border-radius:50%;background:var(--sel);font-size:11px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0}.ch-src .t,.ch-isrc .t{display:block;font-weight:600}.ch-src .s,.ch-isrc .s{display:block}'
        // The composer pickers (profile, thinking level, knowledge): wide enough for a name over its model or document
        // count and the residency and label pills beside them, two lines per item without overlap, and room for a dozen
        // profiles before scrolling. The name and the sub line truncate with an ellipsis rather than wrapping under the
        // pills; the pills never shrink.
        + '.ch-dd{max-height:min(480px,70vh);overflow:auto;min-width:340px;max-width:min(480px,calc(100vw - 32px))}.ch-dd button{height:auto;min-height:32px;padding:6px 10px;gap:10px;align-items:center}.ch-dd button:has(.sub){min-height:42px}'
        + '.ch-dd .grow{min-width:0;display:flex;flex-direction:column;line-height:1.3}.ch-dd .nm{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ch-dd .sub{display:block;font-size:11px;color:var(--muted);font-weight:400;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
        + '.ch-dd .tags{display:inline-flex;align-items:center;gap:6px;flex-shrink:0;margin-left:auto}.ch-dd .tags .pill,.ch-dd .tags .label{flex-shrink:0}'
        + '.ch-card{display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--line);border-radius:8px;background:var(--panel);margin:4px 0}.ch-card.awaiting{border-color:var(--warn-fg);background:var(--warn-bg)}.ch-card.held{border-color:var(--info-fg)}.ch-card.denied,.ch-card.failed{border-color:var(--danger-fg)}.ch-card .ch-args{font-size:12px;overflow-wrap:anywhere}.ch-approval{display:flex;flex-direction:column;gap:6px;padding:10px;border:1px solid var(--accent);border-radius:6px;background:var(--accent-tint)}'
        + '.ch-steps{display:flex;flex-direction:column;gap:4px;font-size:13px}.ch-step{display:flex;gap:8px;align-items:center}.ch-step .num{width:18px;height:18px;border-radius:50%;background:var(--sel);font-size:11px;display:inline-flex;align-items:center;justify-content:center}.ch-step.waiting{color:var(--warn-fg)}.ch-step.failed,.ch-step.denied{color:var(--danger-fg)}'
        + '.ch-skills{display:flex;flex-wrap:wrap;gap:6px;align-items:center}.ch-skills:empty{display:none}.ch-skills .ch-x{margin-left:4px;opacity:.7}'
        + '.ch-picker{position:absolute;left:0;bottom:calc(100% + 4px);top:auto;min-width:360px;max-width:min(560px,100%);z-index:30;max-height:50vh;overflow:auto}.ch-picker .dh{display:flex;justify-content:space-between;gap:8px}.ch-picker button{display:block;width:100%;text-align:left}.ch-picker button .desc{display:block;font-size:11px;color:var(--muted);white-space:normal}.ch-picker button .side{float:right;margin-left:8px}'
        + '@media (max-width:900px){.ch-side{display:none}}.ch-listbtn{display:none}@media (max-width:640px){.ch-left{display:none}.ch-listbtn{display:inline-flex}.ch-left.ch-open{display:flex;position:fixed;top:48px;bottom:0;left:0;z-index:30;width:85%;max-width:320px;max-height:none;border-right:1px solid var(--line);box-shadow:var(--shadow)}.ch-thread{padding:14px 12px}.ch-composer{padding:10px 12px}}'
        + '.ch-pick{max-height:260px;overflow:auto;border:1px solid var(--line);border-radius:6px;margin:8px 0}.ch-pickrow{display:flex;gap:8px;align-items:center;padding:6px 8px;border-bottom:1px solid var(--line);font-size:13px;cursor:pointer}.ch-pickrow:last-child{border-bottom:0}.ch-pickrow input{accent-color:var(--accent)}'
        + '</style>'
        + '<div class="leftpane ch-left' + (st.showList ? ' ch-open' : '') + '">' + UI.btn('New conversation', { icon: 'plus', cls: 'block', attrs: 'data-new' + (canSend ? '' : ' disabled') })
        + UI.search('Search conversations', 'data-search', st.query || '').replace('class="search"', 'class="search" style="width:100%"')
        + '<div class="hstack gap6">' + UI.chip(st.archived ? 'Showing archived' : 'Show archived', !!st.archived, 'data-archived') + '<span class="muted" style="font-size:12px">' + esc(App.DATA.tenant.workspace || '') + '</span></div>'
        + '<div class="ch-list" data-region="list">' + listHtml(st) + '</div><div class="ch-list" data-region="shared">' + sharedListHtml(st) + '</div></div>'
        + (st.sharedView ? sharedPageHtml(st) : st.sharedError && st.sharedToken ? '<div class="page">' + UI.problem('This shared conversation cannot be opened', (st.sharedError.problem && st.sharedError.problem.detail) || st.sharedError.message, st.sharedError.problem && st.sharedError.problem.trace_id) + '</div>' : '<div class="page tight ch-page">'
        + '<div class="ch-head">' + UI.iconbtn('menu', 'Conversations', { cls: 'sm ghost ch-listbtn', attrs: 'data-showlist' })
          + (conv ? '<h1 class="t grow">' + esc(conv.title || 'Untitled conversation') + '</h1>' + (conv.archived ? UI.pill('archived', 'outline') : '') + UI.label(conv.label, { sm: true })
            + (App.can('chat:write') ? UI.btn('Share', { kind: 'ghost', size: 'sm', icon: 'link', attrs: 'data-share' }) : '') + UI.btn('Export', { kind: 'ghost', size: 'sm', icon: 'download', attrs: 'data-export="' + esc(conv.id) + '"' })
            + (App.can('chat:write') ? UI.iconbtn('edit', 'Rename', { cls: 'sm ghost', attrs: 'data-rename' }) + UI.btn(conv.archived ? 'Unarchive' : 'Archive', { kind: 'ghost', size: 'sm', attrs: 'data-archive' }) + UI.iconbtn('trash', 'Delete conversation', { cls: 'sm ghost', attrs: 'data-delete' }) : '')
            : '<h1 class="t grow">' + (st.convId ? 'Conversation' : 'New conversation') + '</h1>' + (st.convId ? '' : UI.label(newLabel(), { sm: true }))) + '</div>'
        + '<div class="ch-scroll"><div class="ch-thread" data-region="thread">' + threadHtml(st) + '</div></div>'
        + '<div class="ch-composer"><div class="ch-inner">'
        + '<div data-region="notice">' + noticeHtml(st) + '</div>'
        + '<div class="hstack wrap gap6"><span class="relative">' + UI.chip(UI.icon('profiles', 12) + ' ' + (p ? esc(p.name) + ' · ' + esc(p.model) : 'No profile'), true, 'data-pick="profile" aria-haspopup="true"' + ((st.profiles || []).length ? '' : ' disabled')) + '</span>'
        + '<span class="relative">' + UI.chip(UI.icon('brain', 12) + ' Thinking: ' + esc(st.think || 'off'), false, 'data-pick="level" aria-haspopup="true"' + (p && p.thinkCeiling !== 'off' ? '' : ' disabled title="This profile does not think"')) + '</span>'
        + (App.can('knowledge:read') ? '<span class="relative">' + UI.chip(UI.icon('knowledge', 12) + ' ' + (boundIds(st).length ? esc(boundIds(st).map((id) => (kbOf(st, id) || { name: 'knowledge base' }).name).join(', ')) : 'Knowledge'), boundIds(st).length > 0, 'data-pick="kb" aria-haspopup="true"' + (App.can('context:write') ? '' : ' disabled title="Your roles do not let you attach knowledge bases"')) + '</span>' : '')
        + (canSend ? UI.chip(UI.icon('copy', 12) + ' Prompts', false, 'data-prompts aria-haspopup="dialog"') : '')
        + (p && p.tools && p.tools.indexOf('calculate') >= 0 ? '<span class="muted hstack gap4" style="font-size:12px">' + UI.icon('calc', 12) + ' Exact calculation on</span>' : '') + '</div>'
        + '<div data-region="cold">' + coldHtml(st) + '</div>'
        + '<div data-region="atts">' + attsHtml(st) + '</div>'
        + '<div class="ch-skills" data-region="skills">' + skillChipsHtml(st) + '</div>'
        + '<div class="relative" data-region="picker">' + pickerHtml(st) + '</div>'
        + '<label class="sr" for="ch-composer">Message</label><textarea id="ch-composer" placeholder="' + (canSend ? (st.convId ? 'Ask something. Type / for a tool or workflow, @ for an agent, + for a skill.' : 'Ask something. Attach a text file with the paper clip.') : 'Read only') + '"' + (canSend ? '' : ' disabled') + ' aria-describedby="ch-composer-hint" role="combobox" aria-autocomplete="list" aria-expanded="false"></textarea>'
        + '<span id="ch-composer-hint" class="sr">In an open conversation, slash opens the tool and workflow picker, at opens the agent picker, plus opens the skill picker; arrow keys move, Enter picks, Escape closes.</span>'
        + '<input type="file" multiple hidden data-file>'
        + '<div class="ch-actions" data-region="actions">' + actionsHtml(st) + '</div>'
        + '</div></div></div>'
        + '<aside class="inspector w300 ch-side" data-region="side">' + sideHtml(st) + '</aside>');

      // Restore the draft, focus and caret across whole-screen renders.
      const ta = ctx.$('#ch-composer');
      if (ta) {
        ta.value = st.draft || '';
        if (st.focus) { ta.focus(); const c = st.caret || [ta.value.length, ta.value.length]; try { ta.setSelectionRange(c[0], c[1]); } catch (e) { /* not focusable */ } }
      }
      const sc = ctx.$('.ch-scroll'); if (sc) sc.scrollTop = sc.scrollHeight;

      // ---- events ----
      ctx.on('input', '#ch-composer', (e, t) => {
        st.draft = t.value;
        // 1.7.0 (B-4008): "/" tools and workflows, "@" agents, "+" skills, from the start of an empty composer.
        const v = t.value; const open = st.convId && /^[/@+]\S*$/.test(v) ? v.charAt(0) : null;
        if (open && (!st.picker || st.picker.key !== open)) { st.picker = { key: open, q: v.slice(1), i: 0 }; if (!st.caps || st.caps.id !== st.convId) loadCaps(st).then(() => paintPicker(st)); }
        else if (st.picker && open) { st.picker.q = v.slice(1); st.picker.i = 0; }
        else if (st.picker) st.picker = null;
        paintPicker(st);
      });
      ctx.on('keydown', '#ch-composer', (e) => {
        if (st.picker) {
          const items = pickerItems(st);
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); st.picker.i = items.length ? (st.picker.i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length : 0; paintPicker(st); return; }
          if (e.key === 'Escape') { e.preventDefault(); closePicker(st); return; }
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (items.length) pickItem(ctx, st, items[st.picker.i]); return; }
          if (e.key === 'Tab') { closePicker(st); return; }
        }
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
      });
      ctx.on('click', '[data-pickitem]', (e, t) => { const items = pickerItems(st); if (items[+t.dataset.pickitem]) pickItem(ctx, st, items[+t.dataset.pickitem]); });
      ctx.on('click', '[data-rmskill]', async (e, t) => { if (!App.can('chat:write')) return; try { await App.del(cUrl(st.convId) + '/skills/' + enc(t.dataset.rmskill)); await Promise.all([loadConv(false), loadCaps(st)]); rerender(); App.toast('Skill removed. The very next turn goes without its instructions.'); } catch (err) { handleError(err, 'Could not remove the skill'); } });
      ctx.on('click', '[data-approve], [data-deny]', async (e, t) => {
        const id = t.dataset.approve || t.dataset.deny; const decision = t.dataset.approve ? 'approve' : 'deny';
        try { const r = await App.post(cUrl(st.convId) + '/invocations/' + enc(id) + '/decide', { decision }); await Promise.all([loadConv(false), loadCards(st)]); rerender(); App.toast(decision === 'deny' ? 'Denied. Nothing ran; the model is told on the next turn.' : r.state === 'held' ? 'Your approval is recorded; the guardrail\'s approver decides next in the Flags queue.' : r.state === 'done' ? esc(r.name) + ' ran as you; its result is in the conversation.' : esc(r.name) + ' is ' + esc(r.state) + '.', decision === 'deny' ? '' : 'ok'); } catch (err) { handleError(err, 'Could not decide the card'); }
      });
      ctx.on('click', '[data-cancelrun]', async (e, t) => { try { await App.post(cUrl(st.convId) + '/invocations/' + enc(t.dataset.cancelrun) + '/cancel', {}); await Promise.all([loadConv(false), loadCards(st)]); rerender(); App.toast('Cancelled from the chat; the Runs screen shows what it reached.'); } catch (err) { handleError(err, 'Could not cancel'); } });
      ctx.on('click', '[data-wfapprove], [data-wfreject]', async (e, t) => {
        const id = t.dataset.wfapprove || t.dataset.wfreject; const decision = t.dataset.wfapprove ? 'approve' : 'reject';
        try { await App.post('/api/workflow-approvals/' + enc(id), { decision, reason: null }); await Promise.all([loadConv(false), loadCards(st)]); rerender(); App.toast(decision === 'approve' ? 'Approved from this conversation; the chain resumes.' : 'Rejected; the run ends and the turn says so.', decision === 'approve' ? 'ok' : ''); } catch (err) { handleError(err, 'Could not decide the approval'); }
      });
      ctx.on('click', '[data-gorun]', (e, t) => { e.preventDefault(); ctx.navigate('runs', { run: t.dataset.gorun }); });
      ctx.on('click', '[data-gochain]', (e, t) => { e.preventDefault(); ctx.navigate('runs', { chain: t.dataset.gochain }); });
      ctx.on('click', '[data-send]', () => send());
      ctx.on('click', '[data-new]', () => { st.showList = false; st.sharedView = null; st.sharedError = null; syncUrl(null); st.convId = null; setConv(st, null); st.notice = null; st.resumed = {}; st.newKbs = []; rerender(true); });
      ctx.on('click', '[data-convo]', (e, t) => { st.showList = false; st.sharedView = null; st.sharedError = null; openConv(t.dataset.convo); });
      ctx.on('click', '[data-showlist]', () => { st.showList = !st.showList; const l = ctx.$('.ch-left'); if (l) l.classList.toggle('ch-open', st.showList); });
      ctx.on('input', '[data-search]', (e, t) => { st.query = t.value; const el = ctx.$('[data-region="list"]'); if (el) el.innerHTML = listHtml(st); });
      ctx.on('click', '[data-archived]', async () => { st.archived = !st.archived; await loadList(); rerender(); });
      ctx.on('click', '[data-dismiss]', () => { st.notice = null; rerender(); });
      ctx.on('click', '[data-art]', (e, t) => { st.artifact = { id: t.dataset.art, version: Number(t.dataset.ver) }; loadArtifactText(st); rerender(); });
      ctx.on('change', '[data-artversion]', (e, t) => { if (st.artifact) { st.artifact = { id: st.artifact.id, version: Number(t.value) }; loadArtifactText(st); rerender(); } });
      ctx.on('click', '[data-artprev], [data-artnext]', (e, t) => { const a = artifactsOf(st).find((x) => x.id === (st.artifact || {}).id); if (!a) return; const i = a.versions.findIndex((x) => x.version === st.artifact.version); const n = a.versions[i + (t.hasAttribute('data-artnext') ? 1 : -1)]; if (n) { st.artifact = { id: a.id, version: n.version }; loadArtifactText(st); rerender(); } });
      ctx.on('click', '[data-artclose]', () => { st.artifact = null; rerender(); });
      ctx.on('click', '[data-artopen]', () => { const a = artifactsOf(st).find((x) => x.id === (st.artifact || {}).id); const v = a && (a.versions.find((x) => x.version === st.artifact.version) || a.versions[a.versions.length - 1]); if (v) window.open(v.rawUrl, '_blank', 'noopener'); });
      ctx.on('click', '[data-artcopy]', async () => {
        const a = artifactsOf(st).find((x) => x.id === (st.artifact || {}).id); const v = a && (a.versions.find((x) => x.version === st.artifact.version) || a.versions[a.versions.length - 1]); if (!v) return;
        try { const text = st.artifactText && st.artifactText.id === v.id ? st.artifactText.content : await fetch(v.rawUrl, { credentials: 'omit' }).then((x) => x.text()); await navigator.clipboard.writeText(text); App.toast('Copied ' + esc(a.key) + ' v' + v.version + '.', 'ok'); } catch (err) { App.toast('Could not copy.', 'warn'); }
      });
      ctx.on('click', '[data-think]', (e, t) => { const id = t.dataset.think; const m = byId(st, id); const cur = st.openThink && st.openThink[id] !== undefined ? st.openThink[id] : active(m) && !m.content; st.openThink = st.openThink || {}; st.openThink[id] = !cur; paint(); });
      ctx.on('click', '[data-cp]', (e, t) => {
        const m = byId(st, t.dataset.cp); if (!m) return;
        const done = () => ctx.toast(m.role === 'user' ? 'Message copied.' : 'Answer copied.');
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(m.content || '').then(done, () => ctx.toast('The browser refused clipboard access.', 'warn'));
        else ctx.toast('The browser refused clipboard access.', 'warn');
      });
      ctx.on('click', '[data-stop]', async (e, t) => {
        t.disabled = true;
        try { const r = await App.post(mUrl(st.conv.id, t.dataset.stop) + '/stop'); ctx.toast(r && r.state === 'stopped' ? 'Stopped. What was produced is kept and metered.' : 'The answer had already finished.'); } catch (err) { t.disabled = false; handleError(err, 'Could not stop'); }
      });
      ctx.on('click', '[data-continue]', async (e, t) => {
        const m = byId(st, t.dataset.continue); if (!m || !st.conv) return;
        t.disabled = true;
        try {
          await App.post(mUrl(st.conv.id, m.id) + '/continue', {});
          // The stored text (and its sequence number) is where the continuation starts: read it before new chunks.
          await loadConv(false);
          ctx.toast('Continuing the answer from where it stopped.');
          paint();
        } catch (err) { t.disabled = false; handleError(err, 'Could not continue the answer'); }
      });
      ctx.on('click', '[data-regen]', (e, t) => regenerate(ctx, t.dataset.regen));
      ctx.on('click', '[data-edit]', (e, t) => editMessage(ctx, t.dataset.edit));
      ctx.on('click', '[data-branch]', async (e, t) => {
        if (!t.dataset.branch || !st.conv) return;
        try { await App.patch(cUrl(st.conv.id), { headId: t.dataset.branch }); await loadConv(false); rerender(); } catch (err) { handleError(err, 'Could not switch branch'); }
      });
      ctx.on('click', '[data-rename]', () => rename(ctx));
      ctx.on('click', '[data-share]', () => shareModal(ctx));
      ctx.on('click', '[data-export]', (e, t) => exportModal(ctx, t.dataset.export));
      ctx.on('click', '[data-prompts]', () => promptPicker(ctx));
      ctx.on('click', '[data-sharedconv]', (e, t) => { st.showList = false; openShared(t.dataset.sharedconv); });
      ctx.on('click', '[data-closeshared]', () => { unwatchShared(st); st.sharedView = null; st.sharedError = null; if (st.sharedToken) { st.sharedToken = null; syncUrl(st.convId); } rerender(); });
      ctx.on('click', '[data-archive]', async () => {
        const c = st.conv; if (!c) return;
        const to = !c.archived;
        const ok = await ctx.confirm({ title: to ? 'Archive this conversation?' : 'Unarchive this conversation?', body: to ? 'It leaves the list but stays readable under Show archived. Nothing is deleted.' : 'It returns to the conversation list.', ok: to ? 'Archive' : 'Unarchive' });
        if (!ok) return;
        try { await App.patch(cUrl(c.id), { archived: to }); ctx.toast(to ? 'Archived. It is listed under Show archived.' : 'Unarchived.', 'ok'); await Promise.all([loadConv(false), loadList()]); rerender(); } catch (err) { handleError(err, 'Could not change the conversation'); }
      });
      ctx.on('click', '[data-delete]', async () => {
        const c = st.conv; if (!c) return;
        const ok = await ctx.confirm({ title: 'Delete this conversation?', tone: 'danger', body: 'Every branch, answer and its thinking is deleted. Usage already metered stays in the usage records. This cannot be undone.', kv: [['Title', esc(c.title || 'Untitled conversation')], ['Messages', num(c.messages.length)]], ok: 'Delete' });
        if (!ok) return;
        try { await App.del(cUrl(c.id)); syncUrl(null); st.convId = null; setConv(st, null); ctx.toast('Conversation deleted.', 'ok'); await loadList(); rerender(); } catch (err) { handleError(err, 'Could not delete'); }
      });
      ctx.on('click', '[data-raise]', async () => {
        const c = st.conv; const sel = ctx.$('[data-raiseto]'); if (!c || !sel) return;
        const to = sel.value;
        const ok = await ctx.confirm({ title: 'Raise the label to ' + to + '?', body: 'A conversation\'s label never goes down again. Only profiles that handle ' + to + ' data can answer here afterwards.', kv: [['From', UI.label(c.label, { sm: true })], ['To', UI.label(to, { sm: true })]], ok: 'Raise label' });
        if (!ok) return;
        try { await App.patch(cUrl(c.id), { label: to }); ctx.toast('Label raised to ' + esc(to) + '.', 'ok'); await Promise.all([loadConv(false), loadList()]); rerender(); } catch (err) { handleError(err, 'Could not raise the label'); }
      });
      ctx.on('click', '[data-goprofile]', (e, t) => { e.preventDefault(); ctx.navigate('profiles', { profile: t.dataset.goprofile }); });
      ctx.on('click', '.ch-cite', (e, t) => {
        e.preventDefault();
        ctx.$$('.ch-src, .ch-isrc').forEach((x) => x.classList.remove('hi'));
        const hits = ctx.$$('[data-src="' + t.dataset.cite + '"][data-mid="' + t.dataset.mid + '"]');
        hits.forEach((x) => x.classList.add('hi'));
        if (hits[0]) hits[0].scrollIntoView({ block: 'nearest' });
      });
      ctx.on('click', '.ch-src, .ch-isrc', (e, t) => {
        const m = byId(st, t.dataset.mid); const c = m && (m.citations || []).find((x) => String(x.n) === t.dataset.src); if (!c) return;
        const tx = citeText(c); const mem = c.kind === 'memory';
        ctx.drawer({ title: esc(tx.title), body: '<div class="fg2">' + esc(tx.sub) + '</div>'
          + UI.kv((mem ? [['Kind', 'memory'], ['Scope', esc(c.scope || '')], ['Type', esc(c.type || '')]] : [['Knowledge base', esc(c.kb || '')], ['Document', esc(c.document || '')], ['Section', esc(c.section || 'none')], ['Score', typeof c.score === 'number' ? esc(c.score.toFixed(3)) : 'not recorded']]).concat([['Label', c.label ? UI.label(c.label, { sm: true }) : ''], ['Cited as', '[' + esc(c.n) + '] in this answer']]), 1)
          + (!mem && (c.passage || c.restricted) ? '<div class="eyebrow">Quoted passage</div>' + (c.restricted ? UI.notice('The passage is labelled ' + esc(c.label || '') + ', above your clearance, so it is not shown.', 'warn') : '<blockquote class="ch-quote serif">' + esc(c.passage) + '</blockquote><div class="muted" style="font-size:11px">Characters ' + esc((c.span || [])[0]) + ' to ' + esc((c.span || [])[1]) + ' of the cited chunk, stored with the answer.</div>') : '')
          + UI.notice(mem ? 'An accepted memory went into the prompt as a labelled block. You can change or forget it on the Memory screen.' : 'The passage went into the prompt as a labelled context block; the conversation\'s label rose to at least its label.', 'info'),
          actions: UI.btn(mem ? 'Open in Memory' : 'Open in Knowledge', { attrs: 'data-close data-gosrc' }) + UI.btn('Close', { kind: 'ghost', attrs: 'data-close' }),
          onMount(d) { d.querySelector('[data-gosrc]').addEventListener('click', () => (mem ? ctx.navigate('memory', { tab: c.scope === 'workspace' ? 'workspace' : 'mine' }) : ctx.navigate('knowledge', { kb: c.kbId }))); } });
      });
      ctx.on('click', '[data-attachbtn]', () => { const f = ctx.$('[data-file]'); if (f) f.click(); });
      ctx.on('change', '[data-file]', (e, t) => { const files = Array.prototype.slice.call(t.files || []); t.value = ''; if (files.length) upload(files); });
      ctx.on('click', '[data-rmatt]', (e, t) => { st.pending = (st.pending || []).filter((a) => a.key !== t.dataset.rmatt); paint(); });
      ctx.on('click', '[data-pick]', (e, t) => {
        const host = t.closest('.relative'); const ex = host.querySelector('.dropdown');
        ctx.$$('.dropdown').forEach((d) => d.remove()); if (ex) return;
        const d = document.createElement('div'); d.className = 'dropdown ch-dd'; d.style.top = 'auto'; d.style.bottom = 'calc(100% + 4px)';
        const cur = selProfile(st);
        if (t.dataset.pick === 'kb') {
          const on = boundIds(st);
          d.innerHTML = '<div class="dh">Knowledge bases you can read</div>' + ((st.kbs || []).length ? st.kbs.map((k) => '<button type="button" data-kb="' + esc(k.id) + '" class="' + (on.indexOf(k.id) >= 0 ? 'on' : '') + '"' + (k.status !== 'published' && on.indexOf(k.id) < 0 ? ' disabled title="Drafts are not searched in chat"' : '') + '><span class="grow"><span class="nm">' + esc(k.name) + '</span><span class="sub">' + (k.status === 'published' ? num(k.documents) + ' documents' : 'draft, not searched in chat') + '</span></span><span class="tags">' + (on.indexOf(k.id) >= 0 ? UI.icon('check', 12) : '') + UI.label(k.label, { sm: true }) + '</span></button>').join('') : '<div class="muted" style="padding:6px 10px;font-size:12px">No knowledge base is shared with you.</div>');
        } else if (t.dataset.pick === 'profile') {
          d.innerHTML = '<div class="dh">Profiles cleared for you</div>' + (st.profiles || []).map((x) => '<button type="button" data-prof="' + esc(x.name) + '" class="' + (cur && x.name === cur.name ? 'on' : '') + '"' + (x.displayName && x.displayName !== x.name ? ' title="' + esc(x.displayName) + '"' : '') + '><span class="grow"><span class="nm">' + esc(x.name) + '</span><span class="sub mono">' + esc(x.model) + '</span></span><span class="tags">' + UI.pill(x.residency, x.residency === 'loaded' ? 'ok' : 'outline') + (x.deprecated ? UI.pill('deprecated', 'warn') : '') + UI.label(x.label, { sm: true }) + '</span></button>').join('');
        } else {
          d.innerHTML = '<div class="dh">Thinking level, ceiling ' + esc(cur ? cur.thinkCeiling : 'off') + '</div>' + levelsFor(cur).map((l) => '<button type="button" data-level="' + l + '" class="' + (l === st.think ? 'on' : '') + '">' + l + (cur && l === cur.thinkDefault ? ' <span class="muted">default</span>' : '') + '</button>').join('');
        }
        host.appendChild(d);
        const outside = (ev) => { if (!d.contains(ev.target) && !host.contains(ev.target)) { d.remove(); document.removeEventListener('click', outside, true); } };
        setTimeout(() => document.addEventListener('click', outside, true), 0);
        d.addEventListener('click', (ev) => {
          const b = ev.target.closest('button'); if (!b) return;
          if (b.dataset.prof) { const np = profileOf(st, b.dataset.prof); st.profile = np.name; st.think = np.thinkDefault; st.forceCold = false; }
          if (b.dataset.level) st.think = b.dataset.level;
          document.removeEventListener('click', outside, true);
          d.remove();
          if (b.dataset.kb) { toggleKb(b.dataset.kb); return; }
          rerender();
        });
      });
    }
  });
})();
