(function () {
  const { UI } = App;
  const esc = UI.esc;

  // An anonymous share link (Sprint 16) opens #/shared?t=<token>, signed-out. Read the token once, before the router
  // sees the address, and take it out of the address bar and history at once. It travels to the server in a POST
  // body only, and nothing is stored: no session, no cookie.
  let linkToken = null;
  (function () {
    const m = /^#\/shared\?(.*)$/.exec(location.hash || '');
    if (!m) return;
    m[1].split('&').forEach((kv) => { const i = kv.indexOf('='); if (i > 0 && kv.slice(0, i) === 't') { try { linkToken = decodeURIComponent(kv.slice(i + 1)); } catch (e) { /* malformed */ } } });
    if (linkToken && !/^exs_[A-Za-z0-9_-]{20,100}$/.test(linkToken)) linkToken = null;
    try { history.replaceState(null, '', location.pathname + location.search + '#/shared'); } catch (e) { /* history unavailable */ }
  })();

  const when = (t) => (t ? new Date(t).toLocaleString() : '');
  const citeLine = (c) => [c.kb || c.kind, c.document, c.section].filter((x) => typeof x === 'string' && x).join(', ') || 'source';

  function open(st, rerender) {
    if (!st.token || st.loading) return;
    st.loading = true;
    App.post('/api/public/shared-links/open', { token: st.token })
      .then((v) => { st.view = v; st.error = null; })
      .catch((err) => { st.view = null; st.error = err; })
      .finally(() => { st.loading = false; rerender(); });
  }

  /** 1.6.0 (B-8001): the artifacts of the shown answers, with a version switcher and the sandboxed render. */
  function artifactsHtml(st, v) {
    const list = v.artifacts || []; if (!list.length) return '';
    const open = st.artifact ? list.find((a) => a.id === st.artifact.id) : null;
    let h = '<div class="sh-a"><div class="eyebrow">Artifacts</div>';
    if (open) {
      const ver = open.versions.find((x) => x.version === st.artifact.version) || open.versions[open.versions.length - 1];
      h += '<div class="hstack wrap gap6"><b class="mono">' + esc(open.key) + '</b>' + UI.pill(open.kind, 'outline') + UI.select(open.versions.map((x) => ({ value: String(x.version), label: 'v' + x.version })), String(ver.version), 'data-artversion aria-label="Version of ' + esc(open.key) + '"') + UI.btn('Close', { kind: 'ghost', size: 'sm', attrs: 'data-artclose' }) + '</div>';
      h += open.kind === 'html' ? '<iframe sandbox="allow-scripts" referrerpolicy="no-referrer" title="' + esc(open.key) + ' version ' + ver.version + '" src="' + esc(ver.rawUrl) + '" style="width:100%;height:320px;border:1px solid var(--line);border-radius:6px;background:var(--panel)"></iframe>'
        : '<pre class="sh-pre" data-artbody>' + (st.artifactText && st.artifactText.id === ver.id ? esc(st.artifactText.content) : '<span class="muted">Loading…</span>') + '</pre>';
    }
    h += '<div class="vstack gap2">' + list.map((a) => UI.listItem(esc(a.key), a.versions.length + ' version' + (a.versions.length > 1 ? 's' : '') + ', ' + esc(a.kind), { active: !!(open && open.id === a.id), attrs: 'data-art="' + esc(a.id) + '" data-ver="' + a.versions[a.versions.length - 1].version + '"' })).join('') + '</div></div>';
    return h;
  }
  function loadArtifactText(st, rerender) {
    const v = st.view; const list = (v && v.artifacts) || []; const open = st.artifact ? list.find((a) => a.id === st.artifact.id) : null; if (!open || open.kind === 'html') return;
    const ver = open.versions.find((x) => x.version === st.artifact.version) || open.versions[open.versions.length - 1];
    if (st.artifactText && st.artifactText.id === ver.id) return;
    fetch(ver.rawUrl, { credentials: 'omit' }).then((x) => { if (!x.ok) throw new Error('HTTP ' + x.status); return x.text(); }).then((content) => { st.artifactText = { id: ver.id, content }; }).catch((err) => { st.artifactText = { id: ver.id, content: 'This version could not be loaded: ' + err.message }; }).then(rerender);
  }
  function messagesHtml(v) {
    return v.messages.map((m) => {
      if (m.role === 'user') return '<div class="sh-q"><div class="eyebrow">Question</div><div class="sh-text">' + esc(m.content).replace(/\n/g, '<br>') + '</div></div>';
      const shown = m.state === 'complete' || m.state === 'stopped';
      return '<div class="sh-a"><div class="eyebrow">Answer' + (m.profile ? ', ' + esc(m.profile) : '') + '</div>'
        + (shown ? '<div class="sh-text serif">' + esc(m.content).replace(/\n/g, '<br>') + '</div>' : '<div class="muted">This answer is not available.</div>')
        + ((m.citations || []).length ? '<div class="sh-src"><div class="eyebrow">Sources</div>' + m.citations.map((c) => '<div>' + esc(String(c.n || '')) + '. ' + esc(citeLine(c)) + '</div>').join('') + '</div>' : '')
        + '</div>';
    }).join('');
  }

  App.register({
    id: 'shared', title: 'Shared conversation', summary: 'A public conversation opened from a link, without signing in', crumb: ['Shared conversation'], live: true,
    label: (st) => (st.view ? st.view.label : null),
    states: [
      { title: 'Link no longer works', tone: 'warn', text: 'Expired, revoked, turned off, or the conversation is no longer public.', apply(ctx) { ctx.state.view = null; ctx.state.error = { status: 404, message: 'Not found' }; ctx.rerender(); } },
      { title: 'Too many openings', tone: 'warn', text: 'Links opened too often from one address wait a minute.', apply(ctx) { ctx.state.view = null; ctx.state.error = { status: 429, message: 'Too many requests' }; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      if (linkToken) { st.token = linkToken; st.view = null; st.error = null; linkToken = null; }
      if (st.token && !st.view && !st.error) open(st, ctx.rerender);
      const style = '<style>'
        + '.sh-wrap{max-width:760px;margin:0 auto;display:flex;flex-direction:column;gap:16px}'
        + '.sh-q,.sh-a{padding:14px 16px;border:1px solid var(--line);border-radius:10px;background:var(--panel);display:flex;flex-direction:column;gap:6px}'
        + '.sh-q{background:var(--panel2)}.sh-text{font-size:15px;line-height:1.55;color:var(--fg);overflow-wrap:anywhere}'
        + '.sh-src{font-size:12px;color:var(--fg2);display:flex;flex-direction:column;gap:2px;margin-top:6px}'
        + '.sh-pre{margin:0;max-height:360px;overflow:auto;padding:10px;border:1px solid var(--line);border-radius:6px;background:var(--panel2);font-family:var(--mono,monospace);font-size:12px;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere}'
        + '</style>';
      let body;
      if (!st.token) body = UI.empty('No link', 'Open the full link you were given. It starts with #/shared?t=.');
      else if (st.loading && !st.view) body = UI.notice('Opening the shared conversation…', 'info');
      else if (st.error) {
        const tooMany = st.error.status === 429;
        body = UI.problem(tooMany ? 'Too many links opened from here' : 'This link does not work', tooMany ? 'Wait a minute, then reload the page.' : 'It may have expired or been revoked, or the conversation is no longer public. Ask the person who shared it for a new link.', st.error.problem && st.error.problem.trace_id);
      } else if (st.view) {
        const v = st.view;
        body = UI.pagehead(esc(v.title || 'Shared conversation'), 'Last updated ' + esc(when(v.updatedAt)), UI.pill('read only', 'outline') + UI.label(v.label, { sm: true }))
          + UI.notice('Shared through a link that works without signing in. You can read this conversation but not add to it. Each opening is recorded.', 'info')
          + (messagesHtml(v) || UI.empty('No messages', 'The conversation has no messages yet.')) + artifactsHtml(st, v);
      }
      root.innerHTML = style + '<div class="page"><div class="sh-wrap">' + body
        + (App.me ? '' : '<div class="muted" style="font-size:12px">Exprsn-AI. <a href="#/signin">Sign in</a> to use chat.</div>')
        + '</div></div>';
      ctx.on('click', '[data-art]', (e, t) => { st.artifact = { id: t.dataset.art, version: Number(t.dataset.ver) }; loadArtifactText(st, ctx.rerender); ctx.rerender(); });
      ctx.on('change', '[data-artversion]', (e, t) => { if (st.artifact) { st.artifact = { id: st.artifact.id, version: Number(t.value) }; loadArtifactText(st, ctx.rerender); ctx.rerender(); } });
      ctx.on('click', '[data-artclose]', () => { st.artifact = null; ctx.rerender(); });
    }
  });
})();
