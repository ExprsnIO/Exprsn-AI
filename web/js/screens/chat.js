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
  function sourcesHtml(m, cls) {
    return (m.citations || []).map((c) => { const t = citeText(c); return '<button type="button" class="' + cls + '" data-src="' + esc(c.n) + '" data-mid="' + esc(m.id) + '"><span class="n">' + esc(c.n) + '</span><span class="grow"><span class="t">' + esc(t.title) + '</span><span class="muted s">' + esc(t.sub) + '</span></span>' + (c.label ? UI.label(c.label, { sm: true }) : '') + '</button>'; }).join('');
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
      'chat.status': guard(onStatus), 'chat.chunk': guard(onChunk), 'chat.done': guard(onDone),
      'attachment.state': guard(onAttachment), connect: guard(onReconnect)
    };
    Object.keys(live.handlers).forEach((ev) => live.sock.on(ev, live.handlers[ev]));
  }
  window.addEventListener('hashchange', () => { if (App.parse().route !== 'chat') detach(); });

  function onStatus(st, d) {
    st.status = st.status || {};
    st.status[d.messageId] = Object.assign({}, st.status[d.messageId] || {}, d);
    if (d.state === 'fallback') { st.fallback = st.fallback || {}; st.fallback[d.messageId] = { from: d.from, profile: d.profile, model: d.model }; }
    if (d.state === 'context' && d.citations) { st.citeFor = st.citeFor || {}; st.citeFor[d.messageId] = true; }
    const m = byId(st, d.messageId);
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
    if (!st.conv || d.conversationId !== st.conv.id) { if (d.conversationId === st.convId) { st.doneBuf = st.doneBuf || {}; st.doneBuf[d.messageId] = d; } return; }
    const m = byId(st, d.messageId);
    if (!m) { st.doneBuf = st.doneBuf || {}; st.doneBuf[d.messageId] = d; return; }
    applyDone(st, m, d);
    // Citations (and a label raised by retrieval) are stored with the answer: reload the conversation to show them.
    if (st.citeFor && st.citeFor[d.messageId]) { delete st.citeFor[d.messageId]; loadConv(false).then(schedule); }
    if (d.state === 'failed') App.toast('<b>The answer failed</b> ' + esc(d.error || ''), 'danger', 6000);
    refreshProfiles();
    schedule();
  }
  function onAttachment(st, d) {
    const a = (st.pending || []).find((x) => x.id === d.id);
    if (!a) return;
    a.state = d.state;
    refreshAttachment(a);
    schedule();
  }
  function onReconnect(st) {
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
    set('thread', threadHtml(st));
    set('atts', attsHtml(st));
    set('actions', actionsHtml(st));
    set('side', sideHtml(st));
    set('cold', coldHtml(st));
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
    const streaming = active(m);
    const openDefault = streaming && !m.content;
    const open = st.openThink && st.openThink[m.id] !== undefined ? st.openThink[m.id] : openDefault;
    const fb = (st.fallback || {})[m.id];
    let h = '<div class="ch-msg ch-ai" data-mid="' + esc(m.id) + '">';
    if (fb) h += UI.notice(esc(fb.from) + ' waited too long in the queue, so ' + esc(fb.profile) + ' (<span class="mono">' + esc(fb.model) + '</span>) is answering instead.', 'warn');
    h += statusLine(st, m);
    if (m.thinking) {
      const u = m.usage;
      h += '<button type="button" class="ch-thinkbar" data-think="' + esc(m.id) + '" aria-expanded="' + (open ? 'true' : 'false') + '"><span>' + UI.icon('brain', 13) + ' ' + (streaming && !m.content ? 'Thinking at level ' + esc(m.think || '') + '…' : 'Thinking' + (m.think ? ' at level ' + esc(m.think) : '') + (u && u.thinkingTokens ? ', ' + num(u.thinkingTokens) + ' tokens' : '')) + '</span><span>' + (open ? 'Hide' : 'Show') + '</span></button>'
        + (open ? '<div class="ch-trace">' + esc(m.thinking).replace(/\n/g, '<br>') + '</div>' : '');
    }
    h += toolsHtml(m);
    if (m.content || streaming) h += '<div class="ch-answer serif">' + richText(m.content, m) + (streaming ? '<span class="blink ch-caret">▍</span>' : '') + '</div>';
    if ((m.citations || []).length && !streaming) h += '<div class="ch-srcs"><div class="eyebrow">Sources</div>' + sourcesHtml(m, 'ch-src') + '</div>';
    const rs = (st.resumed || {})[m.id];
    if (rs) h += '<div class="ch-gap">' + UI.icon('refresh', 12) + ' Stream resumed after event ' + num(rs.at) + (rs.to > rs.at ? '; ' + num(rs.to - rs.at) + ' events caught up' : '') + ', no duplicate text.</div>';
    if (m.state === 'stopped') h += '<div class="ch-final">' + UI.pill('stopped', 'warn') + ' <span class="muted">Stopped. What was produced is kept and metered.</span></div>';
    if (m.state === 'failed') h += UI.notice('<b>The answer failed.</b> ' + esc(m.error || 'No detail was recorded.'), 'danger');
    if (m.state === 'complete' && !m.content && !(m.tools || []).length) h += '<div class="ch-final muted">The model returned an empty answer.</div>';
    h += '<div class="ch-mactions">';
    if (streaming) h += UI.btn('Stop', { kind: 'ghost', size: 'xs', icon: 'stop', attrs: 'data-stop="' + esc(m.id) + '"' });
    else h += UI.iconbtn('copy', 'Copy answer', { cls: 'sm', attrs: 'data-cp="' + esc(m.id) + '"' }) + (App.can('chat:write') && App.can('inference:invoke') ? UI.iconbtn('refresh', 'Regenerate', { cls: 'sm', attrs: 'data-regen="' + esc(m.id) + '"' }) : '');
    h += branchSwitch(conv, m) + '<span class="right muted">' + usageLine(m) + '</span></div>';
    return h + '</div>';
  }
  function userHtml(st, conv, m) {
    return '<div class="ch-msg ch-user" data-mid="' + esc(m.id) + '"><div class="ch-bubble">' + esc(m.content).replace(/\n/g, '<br>') + msgAttachments(m.attachments) + '</div>'
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
    return pathOf(conv).map((m) => (m.role === 'user' ? userHtml(st, conv, m) : aiHtml(st, conv, m))).join('');
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
    if (n.kind === 'forbidden') return UI.notice('<b>' + (p.step === 'zone' ? 'Label above this profile' : 'Above your clearance') + '.</b> ' + esc(p.detail || '') + (p.step === 'zone' ? ' Pick a profile cleared for this label.' : ''), 'danger', close);
    return '';
  }
  function coldHtml(st) {
    const p = selProfile(st);
    if (!p || (p.residency !== 'cold' && !st.forceCold)) return '';
    return '<div class="ch-cold">' + UI.icon('clock', 14) + '<span class="grow"><b>' + esc(p.name) + '</b> uses <span class="mono">' + esc(p.model) + '</span>, which is not loaded on any instance' + (p.residency === 'cold' ? '' : ' in this example; right now it is loaded') + '. Model cold start: the first answer may take a moment while it loads. You can send now; the message queues.</span></div>';
  }
  function sideHtml(st) {
    const conv = st.conv; const p = selProfile(st);
    let h = '';
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
    const p = selProfile(st); if (!p) { App.toast('No profile is available to answer.', 'warn'); return; }
    const block = blocker(st); if (block) { App.toast(esc(block), 'warn'); return; }
    if (st.sending) return;
    st.sending = true; paint();
    const body = { content: text, profile: p.name, think: st.think, attachments: (st.pending || []).map((a) => a.id) };
    try {
      const kbIds = st.newKbs || [];
      if (!st.convId && kbIds.length && App.can('context:write')) {
        // Attach the picked bases before the first message, so its answer already searches them.
        const c = await App.post('/api/conversations', {});
        try {
          await App.api('PUT', cUrl(c.id) + '/knowledge', { kbIds });
          await App.post(cUrl(c.id) + '/messages', body);
        } catch (err) { await App.del(cUrl(c.id)).catch(() => undefined); throw err; }
        st.convId = c.id; st.bound = kbIds; st.newKbs = []; syncUrl(st.convId);
      } else if (!st.convId) {
        const r = await App.post('/api/chat', body);
        st.convId = r.conversationId; st.bound = []; syncUrl(st.convId);
      } else {
        await App.post(cUrl(st.convId) + '/messages', body);
      }
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
    const label = st.conv && rank(st.conv.label) > rank('internal') ? st.conv.label : 'internal';
    for (const file of files) {
      const a = { key: 'k' + Math.random().toString(36).slice(2), name: file.name, size: file.size, state: 'uploading' };
      st.pending.push(a); paint();
      try {
        const res = await fetch('/api/attachments?name=' + enc(file.name) + '&label=' + label, { method: 'PUT', body: file, credentials: 'same-origin', headers: { 'X-CSRF-Token': App.state.csrf || '', 'Content-Type': file.type || 'application/octet-stream', Accept: 'application/json' } });
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

  App.register({
    id: 'chat', title: 'Chat', live: true,
    summary: 'Conversations with branches, streamed answers, thinking, exact calculation and attachments',
    crumb: (st) => ['Chat', st.conv ? (st.conv.title || 'Untitled conversation') : st.convId ? 'Conversation' : 'New conversation'],
    label: (st) => (st.conv ? st.conv.label : st.convId ? null : 'internal'),
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
      const p = selProfile(st);
      const canSend = App.can('chat:write') && App.can('inference:invoke');
      const conv = st.conv;

      root.innerHTML = '<style>'
        + '.ch-list{display:flex;flex-direction:column;gap:2px}'
        + '.ch-page{display:flex;flex-direction:column;min-height:0}.ch-page>.ch-scroll{flex:1 1 auto;min-height:0;overflow:auto}'
        + '.ch-head{display:flex;align-items:center;gap:8px;padding:8px 16px;border-bottom:1px solid var(--line);min-height:44px}.ch-head .t{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
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
        + '.ch-srcs{display:flex;flex-direction:column;gap:4px}.ch-src,.ch-isrc{display:flex;gap:8px;align-items:flex-start;width:100%;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--panel);color:var(--fg);font:inherit;font-size:12px;text-align:left;cursor:pointer}.ch-isrc{border-color:transparent;background:none}'
        + '.ch-src:hover,.ch-isrc:hover,.ch-src.hi,.ch-isrc.hi{background:var(--accent-tint)}.ch-src .n,.ch-isrc .n{width:18px;height:18px;border-radius:50%;background:var(--sel);font-size:11px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0}.ch-src .t,.ch-isrc .t{display:block;font-weight:600}.ch-src .s,.ch-isrc .s{display:block}'
        + '.ch-dd{max-height:320px;overflow:auto;min-width:260px}.ch-dd button{height:auto;min-height:28px;padding:4px 10px}.ch-dd .sub{display:block;font-size:11px;color:var(--muted);font-weight:400}'
        + '@media (max-width:900px){.ch-side{display:none}}.ch-listbtn{display:none}@media (max-width:640px){.ch-left{display:none}.ch-listbtn{display:inline-flex}.ch-left.ch-open{display:flex;position:fixed;top:48px;bottom:0;left:0;z-index:30;width:85%;max-width:320px;max-height:none;border-right:1px solid var(--line);box-shadow:var(--shadow)}.ch-thread{padding:14px 12px}.ch-composer{padding:10px 12px}}'
        + '</style>'
        + '<div class="leftpane ch-left' + (st.showList ? ' ch-open' : '') + '">' + UI.btn('New conversation', { icon: 'plus', cls: 'block', attrs: 'data-new' + (canSend ? '' : ' disabled') })
        + UI.search('Search conversations', 'data-search', st.query || '').replace('class="search"', 'class="search" style="width:100%"')
        + '<div class="hstack gap6">' + UI.chip(st.archived ? 'Showing archived' : 'Show archived', !!st.archived, 'data-archived') + '<span class="muted" style="font-size:12px">' + esc(App.DATA.tenant.workspace || '') + '</span></div>'
        + '<div class="ch-list" data-region="list">' + listHtml(st) + '</div></div>'
        + '<div class="page tight ch-page">'
        + '<div class="ch-head">' + UI.iconbtn('menu', 'Conversations', { cls: 'sm ghost ch-listbtn', attrs: 'data-showlist' })
          + (conv ? '<span class="t grow">' + esc(conv.title || 'Untitled conversation') + '</span>' + (conv.archived ? UI.pill('archived', 'outline') : '') + UI.label(conv.label, { sm: true })
            + (App.can('chat:write') ? UI.iconbtn('edit', 'Rename', { cls: 'sm ghost', attrs: 'data-rename' }) + UI.btn(conv.archived ? 'Unarchive' : 'Archive', { kind: 'ghost', size: 'sm', attrs: 'data-archive' }) + UI.iconbtn('trash', 'Delete conversation', { cls: 'sm ghost', attrs: 'data-delete' }) : '')
            : '<span class="t grow">' + (st.convId ? 'Conversation' : 'New conversation') + '</span>' + (st.convId ? '' : UI.label('internal', { sm: true }))) + '</div>'
        + '<div class="ch-scroll"><div class="ch-thread" data-region="thread">' + threadHtml(st) + '</div></div>'
        + '<div class="ch-composer"><div class="ch-inner">'
        + '<div data-region="notice">' + noticeHtml(st) + '</div>'
        + '<div class="hstack wrap gap6"><span class="relative">' + UI.chip(UI.icon('profiles', 12) + ' ' + (p ? esc(p.name) + ' · ' + esc(p.model) : 'No profile'), true, 'data-pick="profile" aria-haspopup="true"' + ((st.profiles || []).length ? '' : ' disabled')) + '</span>'
        + '<span class="relative">' + UI.chip(UI.icon('brain', 12) + ' Thinking: ' + esc(st.think || 'off'), false, 'data-pick="level" aria-haspopup="true"' + (p && p.thinkCeiling !== 'off' ? '' : ' disabled title="This profile does not think"')) + '</span>'
        + (App.can('knowledge:read') ? '<span class="relative">' + UI.chip(UI.icon('knowledge', 12) + ' ' + (boundIds(st).length ? esc(boundIds(st).map((id) => (kbOf(st, id) || { name: 'knowledge base' }).name).join(', ')) : 'Knowledge'), boundIds(st).length > 0, 'data-pick="kb" aria-haspopup="true"' + (App.can('context:write') ? '' : ' disabled title="Your roles do not let you attach knowledge bases"')) + '</span>' : '')
        + (p && p.tools && p.tools.indexOf('calculate') >= 0 ? '<span class="muted hstack gap4" style="font-size:12px">' + UI.icon('calc', 12) + ' Exact calculation on</span>' : '') + '</div>'
        + '<div data-region="cold">' + coldHtml(st) + '</div>'
        + '<div data-region="atts">' + attsHtml(st) + '</div>'
        + '<label class="sr" for="ch-composer">Message</label><textarea id="ch-composer" placeholder="' + (canSend ? 'Ask something. Attach a text file with the paper clip.' : 'Read only') + '"' + (canSend ? '' : ' disabled') + '></textarea>'
        + '<input type="file" multiple hidden data-file>'
        + '<div class="ch-actions" data-region="actions">' + actionsHtml(st) + '</div>'
        + '</div></div></div>'
        + '<aside class="inspector w300 ch-side" data-region="side">' + sideHtml(st) + '</aside>';

      // Restore the draft, focus and caret across whole-screen renders.
      const ta = ctx.$('#ch-composer');
      if (ta) {
        ta.value = st.draft || '';
        if (st.focus) { ta.focus(); const c = st.caret || [ta.value.length, ta.value.length]; try { ta.setSelectionRange(c[0], c[1]); } catch (e) { /* not focusable */ } }
      }
      const sc = ctx.$('.ch-scroll'); if (sc) sc.scrollTop = sc.scrollHeight;

      // ---- events ----
      ctx.on('input', '#ch-composer', (e, t) => { st.draft = t.value; });
      ctx.on('keydown', '#ch-composer', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
      ctx.on('click', '[data-send]', () => send());
      ctx.on('click', '[data-new]', () => { st.showList = false; syncUrl(null); st.convId = null; setConv(st, null); st.notice = null; st.resumed = {}; st.newKbs = []; rerender(true); });
      ctx.on('click', '[data-convo]', (e, t) => { st.showList = false; openConv(t.dataset.convo); });
      ctx.on('click', '[data-showlist]', () => { st.showList = !st.showList; const l = ctx.$('.ch-left'); if (l) l.classList.toggle('ch-open', st.showList); });
      ctx.on('input', '[data-search]', (e, t) => { st.query = t.value; const el = ctx.$('[data-region="list"]'); if (el) el.innerHTML = listHtml(st); });
      ctx.on('click', '[data-archived]', async () => { st.archived = !st.archived; await loadList(); rerender(); });
      ctx.on('click', '[data-dismiss]', () => { st.notice = null; rerender(); });
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
      ctx.on('click', '[data-regen]', (e, t) => regenerate(ctx, t.dataset.regen));
      ctx.on('click', '[data-edit]', (e, t) => editMessage(ctx, t.dataset.edit));
      ctx.on('click', '[data-branch]', async (e, t) => {
        if (!t.dataset.branch || !st.conv) return;
        try { await App.patch(cUrl(st.conv.id), { headId: t.dataset.branch }); await loadConv(false); rerender(); } catch (err) { handleError(err, 'Could not switch branch'); }
      });
      ctx.on('click', '[data-rename]', () => rename(ctx));
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
          d.innerHTML = '<div class="dh">Knowledge bases you can read</div>' + ((st.kbs || []).length ? st.kbs.map((k) => '<button type="button" data-kb="' + esc(k.id) + '" class="' + (on.indexOf(k.id) >= 0 ? 'on' : '') + '"' + (k.status !== 'published' && on.indexOf(k.id) < 0 ? ' disabled title="Drafts are not searched in chat"' : '') + '><span class="grow">' + esc(k.name) + '<span class="sub">' + (k.status === 'published' ? num(k.documents) + ' documents' : 'draft, not searched in chat') + '</span></span>' + (on.indexOf(k.id) >= 0 ? UI.icon('check', 12) : '') + UI.label(k.label, { sm: true }) + '</button>').join('') : '<div class="muted" style="padding:6px 10px;font-size:12px">No knowledge base is shared with you.</div>');
        } else if (t.dataset.pick === 'profile') {
          d.innerHTML = '<div class="dh">Profiles cleared for you</div>' + (st.profiles || []).map((x) => '<button type="button" data-prof="' + esc(x.name) + '" class="' + (cur && x.name === cur.name ? 'on' : '') + '"><span class="grow">' + esc(x.name) + '<span class="sub mono">' + esc(x.model) + '</span></span>' + UI.pill(x.residency, x.residency === 'loaded' ? 'ok' : 'outline') + (x.deprecated ? UI.pill('deprecated', 'warn') : '') + UI.label(x.label, { sm: true }) + '</button>').join('');
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
