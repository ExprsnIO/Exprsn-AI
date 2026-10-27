(function () {
  const { UI, esc } = App;

  // Search (1.9.0, Sprint 52, B-170 to B-173): one search box over chats, posts, files, knowledge, groups, people, app
  // records and the reader's assistant chats (GET /api/search, /api/search/suggest), with the chat filters of B-171
  // (/api/search/messages) and the post filters of B-172 (/api/search/posts). The server answers as the reader: every
  // source is searched with its own permission and every result is checked again, so nothing here filters for access.
  //
  // The box is an ARIA 1.2 combobox: focus stays in the input, the arrow keys move aria-activedescendant through the
  // grouped listbox of suggestions (results, completions, recent searches), Enter opens the active one or searches,
  // Escape closes the list or clears the box. A status region announces how many suggestions and results there are.
  // Recent searches stay in this browser (localStorage); the server never stores a query. Tenant admins get the
  // "Search index" tab: turn the blind index on, resume or rebuild its backfill, rotate its key, turn it off.
  // The palette lists "Search everything", "Search messages" and "Search posts"; "/" opens the screen from anywhere
  // (a single-key shortcut, off when single-key shortcuts are off in Settings).
  //
  // 1.9.9-qa (B-173, the Sprint 52 leftovers): "Search in this conversation / group / feed" on Messages, Groups and the
  // feed open this screen with the container as a filter (#/search?source=chats&conversation=…, ?source=posts&group=…,
  // &workspace=…, &list=…, &tag=…), shown as a notice with "Search everywhere"; and saved searches (/api/search/saved):
  // a person saves the query with its source and filters, then runs, renames and deletes it. They are theirs alone
  // and sealed on the server; until migration 145 is applied the server says they are unavailable and none of it shows.

  const ID = 'search';
  const enc = encodeURIComponent;
  const SOURCES = [
    { id: 'chats', label: 'Chats', perm: 'messages:read' },
    { id: 'posts', label: 'Posts', perm: 'feed:read' },
    { id: 'files', label: 'Files', perm: 'files:read' },
    { id: 'knowledge', label: 'Knowledge', perm: 'knowledge:read' },
    { id: 'groups', label: 'Groups', perm: 'groups:read' },
    { id: 'people', label: 'People', perm: 'social:read' },
    { id: 'apps', label: 'App records', perm: 'records:read' },
    { id: 'assistant', label: 'Assistant chats', perm: 'chat:read' }
  ];
  const LABELS = ['public', 'internal', 'confidential', 'restricted'];
  const RECENT_KEY = 'exprsn.search.recent';
  const S = () => App.stateFor(ID);
  const allowed = () => SOURCES.filter((x) => App.can(x.perm));
  const srcLabel = (id) => (SOURCES.find((x) => x.id === id) || { label: id }).label;
  const when = (ms) => (ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
  const traceOf = (err) => (err && err.problem && err.problem.trace_id) || false;

  // ---------- recent searches: this browser only ----------

  function recent() {
    try { const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 8) : []; } catch (e) { return []; }
  }
  function remember(q) {
    try { const list = [q].concat(recent().filter((x) => x !== q)).slice(0, 8); localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch (e) { /* storage unavailable */ }
  }
  function forgetRecent() {
    try { localStorage.removeItem(RECENT_KEY); } catch (e) { /* storage unavailable */ }
  }

  // ---------- text with the matched words marked ----------

  function marked(text, highlights) {
    const t = String(text || '');
    const hl = (highlights || []).filter((h) => Array.isArray(h) && h[0] < h[1]).sort((a, b) => a[0] - b[0]);
    let out = ''; let at = 0;
    hl.forEach((h) => { if (h[0] < at) return; out += esc(t.slice(at, h[0])) + '<mark>' + esc(t.slice(h[0], h[1])) + '</mark>'; at = h[1]; });
    return out + esc(t.slice(at));
  }

  // ---------- data ----------

  function filterQuery(st) {
    const f = st.filters || {};
    const p = new URLSearchParams({ q: st.q });
    const add = (k, v) => { if (v) p.set(k, v); };
    const saved = toSaved(st.source, f);
    Object.keys(saved).forEach((k) => add(k, Array.isArray(saved[k]) ? saved[k].join(',') : saved[k]));
    return p;
  }

  /** The screen's filters as the API reads them (a saved search keeps these), for chats and posts only. */
  function toSaved(source, f) {
    f = f || {};
    const out = {};
    const add = (k, v) => { if (v) out[k] = v; };
    if (source === 'chats') {
      add('from', f.from); add('conversation', f.conversation); add('group', f.group); add('workspace', f.workspace); add('after', f.after); add('before', f.before); add('label', f.label); add('mode', f.mode);
      const has = [f.hasFile ? 'file' : '', f.hasLink ? 'link' : ''].filter(Boolean); if (has.length) out.has = has;
    } else if (source === 'posts') {
      add('author', f.author); add('tag', f.tag); add('group', f.group); add('workspace', f.workspace); add('list', f.list); add('kind', f.kind); add('after', f.after); add('before', f.before);
    }
    return out;
  }
  function fromSaved(f) {
    const out = Object.assign({}, f || {});
    const has = Array.isArray(out.has) ? out.has : String(out.has || '').split(',');
    if (has.indexOf('file') >= 0) out.hasFile = true;
    if (has.indexOf('link') >= 0) out.hasLink = true;
    delete out.has;
    return out;
  }

  // ---------- scope: a container's "Search in this …" link ----------

  const SCOPE_KEYS = ['conversation', 'group', 'workspace', 'list', 'tag'];
  /** Applies the container a link names (once per link) as the filters, and asks for the box to take focus. */
  function applyScope(ctx, st) {
    const key = SCOPE_KEYS.map((k) => ctx.params[k] || '').join('|');
    if (key === st.appliedScope) return;
    st.appliedScope = key;
    if (!SCOPE_KEYS.some((k) => ctx.params[k])) return;
    st.filters = {};
    SCOPE_KEYS.forEach((k) => { if (ctx.params[k]) st.filters[k] = ctx.params[k]; });
    st.loaded = false; st.focusBox = true;
  }
  function convName(c) { return c.title || (c.with && (c.with.displayName || c.with.username)) || (c.kind === 'direct' ? 'Direct conversation' : 'Group conversation'); }
  /** What the search is kept to, in words, or null. */
  function scopeOf(st) {
    if (st.source !== 'chats' && st.source !== 'posts') return null;
    const f = st.filters || {}; const pk = st.pickers || { conversations: [], groups: [] };
    if (f.conversation && st.source === 'chats') { const c = pk.conversations.find((x) => x.id === f.conversation); return c ? 'the conversation ' + convName(c) : 'one conversation'; }
    if (f.group) { const g = pk.groups.find((x) => x.id === f.group); return g ? 'the group ' + g.name : 'one group'; }
    if (f.list && st.source === 'posts') return 'one of your lists';
    if (f.tag && st.source === 'posts') return 'posts tagged #' + f.tag;
    if (f.workspace) { const w = ((App.me && App.me.workspaces) || []).find((x) => x.id === f.workspace); return w ? 'the workspace ' + w.name : 'one workspace'; }
    return null;
  }

  // ---------- saved searches: the person's own, on the server ----------

  function loadSaved(st) {
    return App.get('/api/search/saved').then((r) => { st.saved = r || { available: false, items: [] }; }).catch(() => { st.saved = { available: false, items: [] }; });
  }
  const savedOn = (st) => !!(st.saved && st.saved.available);
  function savedSummary(x) {
    const f = x.filters || {};
    const bits = [x.source === 'all' ? 'All sources' : srcLabel(x.source)].concat(Object.keys(f).map((k) => k + ': ' + (Array.isArray(f[k]) ? f[k].join(', ') : f[k])));
    return bits.join(' · ');
  }
  function savedView(st) {
    const items = (st.saved && st.saved.items) || [];
    const list = items.length ? '<ul class="search-hits" aria-label="Saved searches">' + items.map((x) => '<li class="search-hit search-saved">'
      + '<div class="search-saved-row"><button type="button" class="search-saved-run" data-srun="' + esc(x.id) + '">' + esc(x.name) + '</button>'
      + '<span class="hstack gap6">' + UI.btn('Rename', { kind: 'ghost', size: 'sm', attrs: 'data-srename="' + esc(x.id) + '" aria-label="' + esc('Rename ' + x.name) + '"' }) + UI.btn('Delete', { kind: 'ghost', size: 'sm', attrs: 'data-sdel="' + esc(x.id) + '" aria-label="' + esc('Delete ' + x.name) + '"' }) + '</span></div>'
      + '<div class="search-meta"><span>“' + esc(x.q) + '”</span><span>' + esc(savedSummary(x)) + '</span>' + (x.lastRunAt ? '<span>last run ' + esc(when(x.lastRunAt)) + '</span>' : '') + '</div></li>').join('') + '</ul>'
      : '<p class="fg2" style="margin:0">None yet. Search for something, then choose Save this search to keep it here with its filters.</p>';
    return '<section class="panel" aria-labelledby="search-saved-h"><div class="phead"><h2 class="eyebrow" id="search-saved-h" style="margin:0">Saved searches' + (items.length ? ' (' + items.length + ')' : '') + '</h2></div>' + list
      + '<p class="hint" style="margin:8px 0 0">Only you see them. They are kept on the server, sealed; running one searches as you, now.</p></section>';
  }
  function saveDialog(ctx, st) {
    const filters = toSaved(st.source, st.filters);
    const where = st.source === 'all' ? 'All sources' : srcLabel(st.source);
    ctx.modal({
      title: 'Save this search',
      body: '<div class="vstack gap12">' + UI.field('Name', UI.input(st.q.slice(0, 120), { attrs: 'data-sname maxlength="120"' }), 'Only you see your saved searches.')
        + UI.kv([['Words', esc(st.q)], ['Searches', esc(where)], ['Filters', esc(Object.keys(filters).length ? savedSummary({ source: st.source, filters: filters }).split(' · ').slice(1).join(' · ') : 'None')]], 1) + '</div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save', { kind: 'primary', attrs: 'data-ssave' }),
      onMount(m) {
        const go = () => {
          const name = m.querySelector('[data-sname]').value.trim();
          if (!name) { App.toast('Give the search a name.', 'warn'); return; }
          App.post('/api/search/saved', { name: name, q: st.q, source: st.source, filters: filters })
            .then((x) => { App.closeOverlay(); ctx.toast('Saved as ' + esc(x.name) + '.', 'ok'); return loadSaved(st); })
            .then(() => { if (App.state.route === ID) ctx.rerender(); })
            .catch((err) => App.fail(err, 'Not saved'));
        };
        m.querySelector('[data-ssave]').addEventListener('click', go);
        m.querySelector('[data-sname]').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
      }
    });
  }
  function runSaved(ctx, st, id) {
    App.post('/api/search/saved/' + enc(id) + '/run', {}).then((r) => {
      const x = r.saved;
      st.q = x.q; st.source = x.source; st.filters = fromSaved(x.filters); st.results = r.results; st.error = null; st.busy = false;
      st.loaded = true; st.qKey = x.source + '|' + x.q; st.seq = (st.seq || 0) + 1;
      if (st.saved && st.saved.items) st.saved.items = st.saved.items.map((y) => (y.id === x.id ? x : y));
      remember(x.q);
      if ((x.source === 'chats' || x.source === 'posts') && !st.pickers) loadPickers(st).then(() => { if (App.state.route === ID) ctx.rerender(); });
      const params = { q: x.q }; if (x.source !== 'all') params.source = x.source;
      if (ctx.params.q === x.q && (ctx.params.source || 'all') === x.source && !SCOPE_KEYS.some((k) => ctx.params[k])) ctx.rerender(); else ctx.navigate(ID, params);
      setTimeout(() => { const el = document.getElementById('search-status'); if (el) el.textContent = 'Ran the saved search ' + x.name + '. ' + el.textContent; }, 80);
    }).catch((err) => App.fail(err, 'The saved search did not run'));
  }

  async function load(st, append) {
    if (!st.q) { st.results = null; st.error = null; return; }
    const seq = (st.seq = (st.seq || 0) + 1);
    st.busy = true;
    try {
      let r;
      if (st.source === 'all') r = await App.get('/api/search?q=' + enc(st.q) + '&limit=5');
      else if (st.source === 'chats' || st.source === 'posts') {
        const p = filterQuery(st); p.set('limit', '20'); if (append) p.set('offset', String((st.results && st.results.items.length) || 0));
        r = await App.get('/api/search/' + (st.source === 'chats' ? 'messages' : 'posts') + '?' + p.toString());
        if (append && st.results && st.results.items) r.items = st.results.items.concat(r.items);
      } else r = await App.get('/api/search?q=' + enc(st.q) + '&sources=' + enc(st.source) + '&limit=20');
      if (seq !== st.seq) return;
      st.results = r; st.error = null;
    } catch (err) {
      if (seq !== st.seq) return;
      st.results = null; st.error = err;
    } finally { if (seq === st.seq) st.busy = false; }
  }

  async function loadPickers(st) {
    if (st.pickers) return;
    st.pickers = { people: [], conversations: [], groups: [] };
    const tasks = [];
    if (App.can('social:read')) tasks.push(App.get('/api/social/people?limit=200').then((r) => { st.pickers.people = r || []; }).catch(() => undefined));
    if (App.can('messages:read')) tasks.push(App.get('/api/messaging/conversations').then((r) => { st.pickers.conversations = r || []; }).catch(() => undefined));
    if (App.can('groups:read')) tasks.push(App.get('/api/groups?mine=true').then((r) => { st.pickers.groups = Array.isArray(r) ? r : (r && r.items) || []; }).catch(() => undefined));
    await Promise.all(tasks);
  }

  async function loadIndex(st) {
    try { st.index = await App.get('/api/admin/search'); st.indexError = null; } catch (err) { st.index = null; st.indexError = err; }
  }

  // ---------- the combobox ----------

  const box = { timer: null, seq: 0, options: [], active: -1 };

  function optionsFor(st, sugg, value) {
    const out = [];
    if (!value.trim()) {
      recent().forEach((q) => out.push({ group: 'Recent searches', label: q, sub: '', run: { search: q } }));
      return out;
    }
    if (!sugg) return out;
    (sugg.completions || []).forEach((w) => {
      const parts = value.replace(/\s+$/, '').split(/\s+/); parts[parts.length - 1] = w;
      out.push({ group: 'Complete the word', label: parts.join(' '), sub: '', run: { search: parts.join(' ') } });
    });
    (sugg.groups || []).forEach((g) => (g.items || []).forEach((it) => out.push({ group: g.title, label: it.title, sub: it.snippet || it.sub || '', run: { route: it.route } })));
    out.push({ group: 'Search', label: 'Search for “' + value.trim() + '”', sub: 'Every source you can read', run: { search: value.trim() } });
    return out;
  }

  function drawList(root, st) {
    const input = root.querySelector('#search-q'); const list = root.querySelector('#search-listbox'); const status = root.querySelector('#search-status');
    if (!input || !list) return;
    const open = st.listOpen && box.options.length > 0;
    let html = ''; let g = null;
    box.options.forEach((o, i) => {
      if (o.group !== g) { if (g !== null) html += '</div>'; g = o.group; html += '<div role="group" aria-label="' + esc(g) + '"><div class="search-group" aria-hidden="true">' + esc(g) + '</div>'; }
      const on = i === box.active;
      html += '<div class="search-opt' + (on ? ' active' : '') + '" role="option" id="search-opt-' + i + '" aria-selected="' + (on ? 'true' : 'false') + '" data-opt="' + i + '"><span class="search-ol">' + esc(o.label) + '</span>' + (o.sub ? '<span class="search-os">' + esc(String(o.sub).slice(0, 120)) + '</span>' : '') + '</div>';
    });
    if (g !== null) html += '</div>';
    list.innerHTML = html;
    list.hidden = !open;
    input.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open && box.active >= 0) { input.setAttribute('aria-activedescendant', 'search-opt-' + box.active); const a = list.querySelector('#search-opt-' + box.active); if (a && a.scrollIntoView) a.scrollIntoView({ block: 'nearest' }); }
    else input.removeAttribute('aria-activedescendant');
    if (status && st.listOpen) {
      const n = box.options.filter((o) => !o.run.search || o.group !== 'Search').length;
      status.textContent = !input.value.trim() ? (n ? n + ' recent search' + (n === 1 ? '' : 'es') : '') : n ? n + ' suggestion' + (n === 1 ? '' : 's') + '. Use the arrow keys to move through them.' : 'No suggestions. Press Enter to search.';
    }
  }

  function suggest(root, st) {
    const input = root.querySelector('#search-q'); if (!input) return;
    const value = input.value;
    clearTimeout(box.timer);
    if (value.trim().length < 2) { box.options = optionsFor(st, null, value); box.active = -1; st.listOpen = document.activeElement === input; drawList(root, st); return; }
    box.timer = setTimeout(() => {
      const seq = ++box.seq;
      App.get('/api/search/suggest?q=' + enc(value)).then((r) => {
        if (seq !== box.seq || App.state.route !== ID) return;
        box.options = optionsFor(st, r, value); box.active = -1; st.listOpen = document.activeElement === root.querySelector('#search-q'); drawList(root, st);
      }).catch(() => { if (seq === box.seq) { box.options = optionsFor(st, null, value); drawList(root, st); } });
    }, 160);
  }

  function activate(ctx, st, o) {
    st.listOpen = false;
    if (o.run.route) { App.navigate(o.run.route.split('?')[0], Object.fromEntries(new URLSearchParams(o.run.route.split('?')[1] || ''))); return; }
    if (o.run.search) submit(ctx, st, o.run.search);
  }

  function submit(ctx, st, q) {
    const v = String(q || '').trim();
    if (!v) { App.toast('Type something to search for.', 'warn'); return; }
    remember(v);
    st.listOpen = false;
    const params = { q: v }; if (st.source && st.source !== 'all') params.source = st.source;
    if (ctx.params.q === v && (ctx.params.source || 'all') === (st.source || 'all')) { st.loaded = false; ctx.rerender(); return; }
    ctx.navigate(ID, params);
  }

  // ---------- views ----------

  const STYLE = '<style>'
    + '.search-box{position:relative;max-width:760px}'
    + '.search-row{display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap}'
    + '.search-row .field{flex:1 1 220px;min-width:0;margin:0}'
    + '.search-listbox{position:absolute;left:0;right:0;top:100%;z-index:20;margin-top:4px;max-height:min(420px,60vh);overflow:auto;background:var(--panel);border:1px solid var(--line);border-radius:8px;box-shadow:var(--shadow);padding:6px}'
    + '.search-group{padding:8px 10px 4px;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}'
    + '.search-opt{display:flex;flex-direction:column;gap:2px;padding:7px 10px;border-radius:5px;cursor:pointer;color:var(--fg)}'
    + '.search-opt.active,.search-opt:hover{background:var(--sel)}'
    + '.search-opt.active{box-shadow:inset 3px 0 0 var(--focus)}'
    + '.search-ol{overflow-wrap:anywhere}'
    + '.search-os{font-size:12px;color:var(--fg2);overflow-wrap:anywhere}'
    + '.search-hits{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}'
    + '.search-hit{padding:8px 0;border-top:1px solid var(--line);min-width:0}'
    + '.search-hit:first-child{border-top:0}'
    + '.search-hit a{font-weight:600;overflow-wrap:anywhere}'
    + '.search-meta{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:12px;color:var(--fg2)}'
    + '.search-snip{margin:4px 0 0;color:var(--fg);overflow-wrap:anywhere}'
    + '.search-snip mark{background:var(--warn-bg);color:var(--fg);font-weight:700;padding:0 1px;border-radius:2px}'
    + '.search-filters{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:10px;align-items:end}'
    + '.search-filters .field{margin:0;min-width:0}'
    + '.search-filters .select,.search-filters .input{width:100%;min-width:0}'
    + '.search-recent{display:flex;flex-wrap:wrap;gap:6px;align-items:center}'
    + '.search-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,320px),1fr));gap:12px}'
    + '.search-saved-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center;justify-content:space-between}'
    + '.search-saved-run{border:0;background:transparent;padding:0;font:inherit;font-weight:600;color:var(--accent);text-decoration:underline;cursor:pointer;text-align:left;overflow-wrap:anywhere;min-width:0}'
    + '.search-saved-run:hover{color:var(--fg)}'
    + '</style>';

  function hitHtml(it) {
    const route = it.route || '';
    return '<li class="search-hit"><a href="#/' + esc(route) + '">' + esc(it.title) + '</a>'
      + '<div class="search-meta">' + (it.sub ? '<span>' + esc(it.sub) + '</span>' : '') + (it.at ? '<span>' + esc(when(it.at)) + '</span>' : '') + (it.label ? UI.label(it.label, { sm: true }) : '') + '</div>'
      + (it.snippet ? '<p class="search-snip">' + marked(it.snippet, it.highlights) + '</p>' : '') + '</li>';
  }

  function messageHit(m) {
    const title = (m.conversation && m.conversation.title) || (m.conversation && m.conversation.kind === 'direct' ? 'Direct conversation' : 'Group conversation');
    return hitHtml({ title: title, sub: (m.authorName || 'Someone') + (m.hasFile ? ' · has a file' : ''), at: m.createdAt, label: m.label, snippet: m.snippet, highlights: m.highlights, route: m.route });
  }

  function postHit(p) {
    return hitHtml({ title: (p.kind === 'comment' ? 'Comment by ' : 'Post by ') + (p.authorName || 'someone'), sub: (p.tags || []).map((t) => '#' + t).join(' '), at: p.createdAt, label: p.label, snippet: p.snippet, highlights: p.highlights, route: p.route });
  }

  function engineNote(r) {
    return r && r.engine === 'fallback' ? UI.notice('The search index is off or still being built here, so chats are searched word by word without phrases or prefixes, and posts from the newest ones only.', 'info') : '';
  }

  function allView(st) {
    const r = st.results;
    const groups = (r.groups || []);
    const n = groups.reduce((a, g) => a + (g.items || []).length, 0);
    if (!n) return engineNote(r) + UI.empty('Nothing found', 'Nothing you can read matches “' + st.q + '”. Try fewer words, or a word’s beginning followed by *.');
    return engineNote(r) + '<div class="search-grid">' + groups.filter((g) => (g.items || []).length || g.error).map((g) => {
      const more = g.source === 'chats' || g.source === 'posts' || (g.items || []).length >= 5 ? UI.btn('Show all', { kind: 'ghost', size: 'sm', attrs: 'data-showsrc="' + esc(g.source) + '" aria-label="' + esc('Show all ' + g.title.toLowerCase()) + '"' }) : '';
      const body = g.error ? '<p class="fg2" style="margin:0">' + esc(g.error) + '</p>' : '<ul class="search-hits">' + g.items.map(hitHtml).join('') + '</ul>';
      return '<section class="panel" aria-labelledby="search-h-' + esc(g.source) + '"><div class="phead"><h2 class="eyebrow" id="search-h-' + esc(g.source) + '" style="margin:0">' + esc(g.title) + (g.total != null ? ' (' + g.total + ')' : '') + '</h2>' + (more ? '<div class="hstack gap6">' + more + '</div>' : '') + '</div>' + body + '</section>';
    }).join('') + '</div>';
  }

  function sourceView(st) {
    const r = st.results;
    if (st.source === 'chats' || st.source === 'posts') {
      const items = r.items || [];
      const list = items.length ? '<ul class="search-hits">' + items.map(st.source === 'chats' ? messageHit : postHit).join('') + '</ul>' : UI.empty('Nothing found', 'Nothing you can read matches these words and filters.');
      const more = items.length < (r.total || 0) ? '<div style="margin-top:10px">' + UI.btn('More results', { attrs: 'data-more' }) + '</div>' : '';
      return engineNote(r) + (r.partial ? UI.notice('Only the newest posts were searched; the search index will search them all.', 'info') : '') + '<section class="panel" aria-label="Results">' + list + more + '</section>';
    }
    const g = (r.groups || [])[0];
    if (!g) return UI.empty('Nothing found', 'You cannot search this source.');
    if (g.error) return UI.problem(g.title + ' could not be searched', g.error);
    return g.items.length ? '<section class="panel" aria-label="Results"><ul class="search-hits">' + g.items.map(hitHtml).join('') + '</ul></section>' : UI.empty('Nothing found', 'Nothing in ' + g.title.toLowerCase() + ' matches “' + st.q + '”.');
  }

  function filtersView(st) {
    const f = st.filters || (st.filters = {});
    const pk = st.pickers || { people: [], conversations: [], groups: [] };
    const people = [{ value: '', label: 'Anyone' }].concat(pk.people.map((p) => ({ value: p.userId, label: p.displayName || p.username })));
    const dates = UI.field('From date', UI.input(f.after || '', { type: 'date', attrs: 'data-f="after"' })) + UI.field('To date', UI.input(f.before || '', { type: 'date', attrs: 'data-f="before"' }));
    if (st.source === 'chats') {
      if (App.me && App.me.user) people.splice(1, 0, { value: App.me.user.id, label: 'Me' });
      const convs = [{ value: '', label: 'Any conversation' }].concat(pk.conversations.map((c) => ({ value: c.id, label: c.title || (c.with && (c.with.displayName || c.with.username)) || (c.kind === 'direct' ? 'Direct conversation' : 'Group conversation') })));
      return '<div class="search-filters" role="group" aria-label="Filters">' + UI.field('Who wrote it', UI.select(people, f.from || '', 'data-f="from"')) + UI.field('Conversation', UI.select(convs, f.conversation || '', 'data-f="conversation"')) + dates
        + UI.field('Label', UI.select([{ value: '', label: 'Any label' }].concat(LABELS.map((l) => ({ value: l, label: l }))), f.label || '', 'data-f="label"'))
        + UI.field('Match', UI.select([{ value: '', label: 'Words and meaning' }, { value: 'keyword', label: 'Words only' }, { value: 'semantic', label: 'Meaning only' }], f.mode || '', 'data-f="mode"'))
        + '<div class="field" role="group" aria-label="Has"><span class="fl" aria-hidden="true">Has</span><div class="hstack wrap gap12">' + UI.check('A file', !!f.hasFile, 'data-fc="hasFile"') + UI.check('A link', !!f.hasLink, 'data-fc="hasLink"') + '</div></div>'
        + '</div>';
    }
    const groups = [{ value: '', label: 'Any group or feed' }].concat(pk.groups.map((g) => ({ value: g.id, label: g.name })));
    return '<div class="search-filters" role="group" aria-label="Filters">' + UI.field('Author', UI.select(people.concat(App.me && App.me.user ? [{ value: App.me.user.id, label: 'Me' }] : []), f.author || '', 'data-f="author"')) + UI.field('Tag', UI.input(f.tag || '', { placeholder: '#tag', attrs: 'data-f="tag" maxlength="65"' })) + UI.field('Group', UI.select(groups, f.group || '', 'data-f="group"'))
      + UI.field('Show', UI.select([{ value: '', label: 'Posts and comments' }, { value: 'post', label: 'Posts' }, { value: 'comment', label: 'Comments' }], f.kind || '', 'data-f="kind"')) + dates + '</div>';
  }

  function indexView(st) {
    if (st.indexError) return UI.problem('The index state could not be read', st.indexError.message, traceOf(st.indexError));
    const x = st.index;
    if (!x) return UI.notice('Reading the index state…', 'info');
    if (!x.installed) return UI.empty('Not installed yet', 'This server needs migrations 138_search_index and 139_search_state. Search works as before meanwhile.');
    const facts = UI.kv([['State', x.state === 'off' ? 'Off' : x.state === 'building' ? 'Building' : 'Ready'], ['Version in use', x.activeVersion == null ? 'None yet' : String(x.activeVersion)], ['Being built', x.buildingVersion == null ? 'Nothing' : 'Version ' + x.buildingVersion], ['Documents', String(x.documents)]]);
    const prog = x.progress ? UI.meter('Backfill (' + x.progress.at + 's)', x.progress.processed + ' of about ' + x.progress.total, x.progress.percent) : '';
    const err = x.error ? UI.notice('The last backfill stopped: ' + esc(x.error) + '. Resume it to carry on from where it stopped.', 'warn') : '';
    const acts = !x.enabled ? UI.btn('Turn the index on', { kind: 'primary', attrs: 'data-ix="enable"' })
      : (x.buildingVersion != null ? UI.btn('Resume the backfill', { attrs: 'data-ix="resume"' }) : '') + UI.btn('Rebuild', { attrs: 'data-ix="rebuild"' }) + UI.btn('Rotate the key', { attrs: 'data-ix="rotate"' }) + UI.btn('Turn off', { kind: 'danger', attrs: 'data-ix="disable"' });
    return UI.panel('Search index', '<div class="vstack gap12"><p class="fg2" style="margin:0">Messages, posts and comments are sealed, so word search runs on a blind index: keyed hashes of their words under this tenant’s search key, never the words. It shows how often hashed words occur and which occur together, and each document’s length; see the security notes.</p>' + facts + prog + err + '<div class="hstack wrap gap6">' + acts + '</div></div>');
  }

  const ACTIONS = {
    enable: { title: 'Turn the search index on', body: 'New messages, posts and comments are indexed as they are written, and a backfill indexes what exists. Search uses the index once the backfill finishes.', ok: 'Turn on', path: 'enable', done: 'The index is on; the backfill is running.' },
    resume: { title: 'Resume the backfill', body: 'It carries on from where it stopped.', ok: 'Resume', path: 'rebuild', body2: { restart: false }, done: 'The backfill carries on.' },
    rebuild: { title: 'Rebuild the index', body: 'Everything is indexed again under a new version; search keeps the current one until it is complete.', ok: 'Rebuild', path: 'rebuild', body2: { restart: true }, done: 'The rebuild is running.' },
    rotate: { title: 'Rotate the search key', body: 'A new key is made and everything is indexed again under it; then the old key and everything hashed with it are deleted.', ok: 'Rotate', path: 'rotate', done: 'The rotation is running.' },
    disable: { title: 'Turn the search index off', body: 'The index and its keys are deleted. Search goes back to the older per-conversation word search.', ok: 'Turn off', tone: 'danger', path: 'disable', done: 'The index is off and deleted.' }
  };

  App.register({
    id: ID, title: 'Search', live: true, summary: 'One search box over chats, posts, files, knowledge, groups, people and app records',
    crumb: (st) => ['Search'].concat(st.q ? ['“' + st.q + '”'] : []),
    commands: [
      { label: 'Search everything', sub: 'Chats, posts, files, knowledge, groups, people and app records', run: () => { const i = document.getElementById('search-q'); if (i) i.focus(); } },
      { label: 'Search messages', sub: 'Every conversation you are in, with filters', params: { source: 'chats' }, run: () => { const i = document.getElementById('search-q'); if (i) i.focus(); } },
      { label: 'Search posts', sub: 'Posts and comments in the feed, groups and lists', params: { source: 'posts' }, run: () => { const i = document.getElementById('search-q'); if (i) i.focus(); } },
      { label: 'Saved searches', sub: 'Run a search you saved, with its filters', run: () => { const b = document.querySelector('[data-srun]') || document.getElementById('search-q'); if (b) b.focus(); } }
    ],
    states: [
      { title: 'Nothing found', tone: 'info', text: 'No source has anything the reader can read for the words.', apply(ctx) { const st = ctx.state; st.q = 'xylophone'; st.source = 'all'; st.results = { q: 'xylophone', engine: 'index', groups: [] }; st.error = null; st.loaded = true; st.qKey = 'all|xylophone'; ctx.rerender(); } },
      { title: 'Index being built', tone: 'warn', text: 'Before the backfill finishes, chats and posts are searched the older way.', apply(ctx) { const st = ctx.state; st.q = 'budget'; st.source = 'all'; st.results = { q: 'budget', engine: 'fallback', groups: [{ source: 'chats', title: 'Chats', total: 1, error: null, items: [{ id: 'x', title: 'Launch', sub: 'Ann', snippet: 'the budget for the launch', highlights: [[4, 10]], label: 'internal', at: Date.now(), route: 'messages' }] }] }; st.loaded = true; st.qKey = 'all|budget'; ctx.rerender(); } },
      { title: 'A source unavailable', tone: 'warn', text: 'One source failed; the others still answer.', apply(ctx) { const st = ctx.state; st.q = 'plan'; st.source = 'all'; st.results = { q: 'plan', engine: 'index', groups: [{ source: 'files', title: 'Files', total: null, error: 'This source could not be searched just now.', items: [] }, { source: 'people', title: 'People', total: 1, error: null, items: [{ id: 'p', title: 'Planner Pat', sub: '@pat', snippet: null, highlights: [], label: null, at: null, route: 'person?user=me' }] }] }; st.loaded = true; st.qKey = 'all|plan'; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      const sources = allowed();
      const want = { q: (ctx.params.q || '').trim(), source: ctx.params.source || st.source || 'all' };
      if (want.source !== 'all' && want.source !== 'index' && !sources.some((x) => x.id === want.source)) want.source = 'all';
      if (want.source === 'index' && !App.can('tenant:manage')) want.source = 'all';
      applyScope(ctx, st);
      if (st.saved === undefined && !st.savedLoading) { st.savedLoading = true; loadSaved(st).then(() => { st.savedLoading = false; if (App.state.route === ID) ctx.rerender(); }); }
      const key = want.source + '|' + want.q;
      if (!st.loaded || st.qKey !== key) {
        st.loaded = true; st.qKey = key; st.q = want.q; st.source = want.source; st.results = null; st.error = null;
        if (st.source === 'index') loadIndex(st).then(() => ctx.rerender());
        else if (st.q) { st.busy = true; load(st).then(() => { if (App.state.route === ID) ctx.rerender(); }); }
        if ((st.source === 'chats' || st.source === 'posts') && !st.pickers) loadPickers(st).then(() => { if (App.state.route === ID) ctx.rerender(); });
      }
      const tabs = [{ id: 'all', label: 'All' }].concat(sources.map((x) => ({ id: x.id, label: x.label }))).concat(App.can('tenant:manage') ? [{ id: 'index', label: 'Search index' }] : []);
      const rec = recent();
      const form = '<div class="search-box" role="search">'
        + '<div class="search-row">' + '<div class="field"><label for="search-q">Search</label>'
        + '<input class="input" type="text" id="search-q" value="' + esc(st.draft != null ? st.draft : st.q || '') + '" role="combobox" aria-expanded="false" aria-controls="search-listbox" aria-autocomplete="list" aria-describedby="search-help" autocomplete="off" spellcheck="false" maxlength="500"></div>'
        + UI.btn('Search', { kind: 'primary', icon: 'search', attrs: 'data-go' }) + '</div>'
        + '<div class="search-listbox" id="search-listbox" role="listbox" aria-label="Suggestions" hidden></div>'
        + '<div class="hint" id="search-help">Words must all match. Put a phrase in quotes; end a word with * to match its beginning.</div>'
        + '</div>';
      const recentRow = !st.q && rec.length ? '<div class="search-recent"><span class="fg2">Recent:</span>' + rec.map((q) => UI.btn(q, { kind: 'ghost', size: 'sm', attrs: 'data-recent="' + esc(q) + '"' })).join('') + UI.btn('Clear recent searches', { kind: 'ghost', size: 'sm', attrs: 'data-clearrecent' }) + '</div>' : '';
      let body;
      const scope = scopeOf(st);
      const scopeNote = scope ? UI.notice('Searching only in ' + esc(scope) + '.', 'info', UI.btn('Search everywhere', { kind: 'ghost', size: 'sm', attrs: 'data-unscope' })) : '';
      const saveRow = st.q && savedOn(st) && st.source !== 'index' && sources.length ? '<div class="hstack wrap gap6">' + UI.btn('Save this search', { size: 'sm', icon: 'plus', attrs: 'data-savesearch' }) + '</div>' : '';
      if (!sources.length && st.source !== 'index') body = UI.empty('Nothing to search', 'Your roles give you no source to search. Ask a tenant admin for access.');
      else if (st.source === 'index') body = indexView(st);
      else if (!st.q) body = (scope ? UI.empty('Search in ' + scope, 'Type the words to look for. The search stays in ' + scope + ' until you choose Search everywhere.') : UI.empty('Search everything you can read', 'Chats, posts, files, knowledge, groups, people, app records and your assistant chats, grouped by where they come from.')) + (savedOn(st) ? savedView(st) : '');
      else if (st.error) body = UI.problem('Search failed', st.error.message, traceOf(st.error));
      else if (!st.results) body = '<p class="fg2" aria-busy="true">Searching…</p>';
      else body = st.source === 'all' ? allView(st) : sourceView(st);
      const filters = st.source === 'chats' || st.source === 'posts' ? filtersView(st) : '';
      const count = st.results ? (st.source === 'all' ? (st.results.groups || []).reduce((a, g) => a + (g.items || []).length, 0) : st.results.items ? st.results.items.length : ((st.results.groups || [])[0] || { items: [] }).items.length) : null;
      root.innerHTML = STYLE + '<div class="page"><div class="vstack gap12">'
        + UI.pagehead('Search', 'You see only what you could open yourself; each source is searched as you.')
        + form + recentRow
        + '<div class="sr" role="status" aria-live="polite" id="search-status">' + (st.q && st.results && st.source !== 'index' ? esc(count === 0 ? 'No results for ' + st.q : count + ' result' + (count === 1 ? '' : 's') + ' for ' + st.q + (st.source === 'all' ? '' : ' in ' + srcLabel(st.source))) : '') + '</div>'
        + UI.tabs(tabs, st.source)
        + '<div class="vstack gap12">' + scopeNote + saveRow + filters + body + '</div>'
        + '</div></div>';
      st.draft = null;
      box.options = []; box.active = -1; st.listOpen = false;
      if (st.focusBox) { st.focusBox = false; setTimeout(() => { const i = root.querySelector('#search-q'); if (i && App.state.route === ID) i.focus(); }, 0); }

      ctx.on('input', '#search-q', () => { st.draft = root.querySelector('#search-q').value; suggest(root, st); });
      ctx.on('focusin', '#search-q', () => { st.listOpen = true; if (!box.options.length) suggest(root, st); else drawList(root, st); });
      ctx.on('focusout', '#search-q', () => { setTimeout(() => { if (document.activeElement !== root.querySelector('#search-q')) { st.listOpen = false; drawList(root, st); } }, 120); });
      ctx.on('keydown', '#search-q', (e) => {
        const input = root.querySelector('#search-q'); const n = box.options.length;
        if (e.key === 'ArrowDown') { e.preventDefault(); if (!st.listOpen) { st.listOpen = true; suggest(root, st); return; } if (n) { box.active = (box.active + 1) % n; drawList(root, st); } }
        else if (e.key === 'ArrowUp') { e.preventDefault(); if (n && st.listOpen) { box.active = box.active <= 0 ? n - 1 : box.active - 1; drawList(root, st); } }
        else if (e.key === 'Home' && st.listOpen && box.active >= 0) { e.preventDefault(); box.active = 0; drawList(root, st); }
        else if (e.key === 'End' && st.listOpen && box.active >= 0) { e.preventDefault(); box.active = n - 1; drawList(root, st); }
        else if (e.key === 'Enter') { e.preventDefault(); const o = st.listOpen && box.active >= 0 ? box.options[box.active] : null; if (o) activate(ctx, st, o); else submit(ctx, st, input.value); }
        else if (e.key === 'Escape') { if (st.listOpen && n) { e.preventDefault(); e.stopPropagation(); st.listOpen = false; box.active = -1; drawList(root, st); } else if (input.value) { e.preventDefault(); input.value = ''; st.draft = ''; suggest(root, st); } }
      });
      ctx.on('mousedown', '#search-listbox', (e) => e.preventDefault());
      ctx.on('click', '[data-opt]', (e, t) => { const o = box.options[Number(t.dataset.opt)]; if (o) activate(ctx, st, o); });
      ctx.on('click', '[data-go]', () => submit(ctx, st, root.querySelector('#search-q').value));
      ctx.on('click', '[data-recent]', (e, t) => submit(ctx, st, t.dataset.recent));
      ctx.on('click', '[data-clearrecent]', () => { forgetRecent(); ctx.toast('Recent searches cleared from this browser.', 'ok'); ctx.rerender(); });
      ctx.on('click', '[data-tab]', (e, t) => { const params = { source: t.dataset.tab }; if (st.q && t.dataset.tab !== 'index') params.q = st.q; if (t.dataset.tab === 'all') delete params.source; ctx.navigate(ID, params); });
      ctx.on('click', '[data-showsrc]', (e, t) => ctx.navigate(ID, { q: st.q, source: t.dataset.showsrc }));
      ctx.on('click', '[data-more]', () => load(st, true).then(() => ctx.rerender()));
      ctx.on('click', '[data-unscope]', () => {
        SCOPE_KEYS.forEach((k) => { if (st.filters) delete st.filters[k]; });
        st.loaded = false;
        const params = { source: st.source }; if (st.q) params.q = st.q;
        if (SCOPE_KEYS.some((k) => ctx.params[k])) ctx.navigate(ID, params); else ctx.rerender();
        ctx.toast('Searching everywhere you can read.', 'ok');
      });
      ctx.on('click', '[data-savesearch]', () => saveDialog(ctx, st));
      ctx.on('click', '[data-srun]', (e, t) => runSaved(ctx, st, t.dataset.srun));
      ctx.on('click', '[data-srename]', (e, t) => {
        const x = ((st.saved && st.saved.items) || []).find((y) => y.id === t.dataset.srename); if (!x) return;
        ctx.modal({ title: 'Rename saved search', body: UI.field('Name', UI.input(x.name, { attrs: 'data-rname maxlength="120"' })), actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Rename', { kind: 'primary', attrs: 'data-rgo' }),
          onMount(m) {
            m.querySelector('[data-rgo]').addEventListener('click', () => {
              const name = m.querySelector('[data-rname]').value.trim(); if (!name) { App.toast('Give the search a name.', 'warn'); return; }
              App.patch('/api/search/saved/' + enc(x.id), { name: name }).then((y) => { App.closeOverlay(); ctx.toast('Renamed to ' + esc(y.name) + '.', 'ok'); return loadSaved(st); }).then(() => { if (App.state.route === ID) ctx.rerender(); }).catch((err) => App.fail(err, 'Not renamed'));
            });
          } });
      });
      ctx.on('click', '[data-sdel]', async (e, t) => {
        const x = ((st.saved && st.saved.items) || []).find((y) => y.id === t.dataset.sdel); if (!x) return;
        if (!(await ctx.confirm({ title: 'Delete saved search', tone: 'danger', body: '<p class="fg2" style="margin:0">' + esc(x.name) + ' is deleted. Your recent searches in this browser stay.</p>', ok: 'Delete' }))) return;
        App.del('/api/search/saved/' + enc(x.id)).then(() => { ctx.toast('Deleted ' + esc(x.name) + '.', 'warn'); return loadSaved(st); }).then(() => { if (App.state.route === ID) ctx.rerender(); }).catch((err) => App.fail(err, 'Not deleted'));
      });
      ctx.on('change', '[data-f]', (e, t) => { st.filters = st.filters || {}; st.filters[t.dataset.f] = t.value.trim(); if (st.q) load(st).then(() => ctx.rerender()); });
      ctx.on('change', '[data-fc]', (e, t) => { st.filters = st.filters || {}; st.filters[t.dataset.fc] = t.checked; if (st.q) load(st).then(() => ctx.rerender()); });
      ctx.on('click', '[data-ix]', async (e, t) => {
        const a = ACTIONS[t.dataset.ix]; if (!a) return;
        if (!(await ctx.confirm({ title: a.title, tone: a.tone, body: '<p class="fg2" style="margin:0">' + esc(a.body) + '</p>', ok: a.ok }))) return;
        try { st.index = await App.post('/api/admin/search/' + a.path, a.body2 || {}); ctx.toast(a.done, 'ok'); ctx.rerender(); } catch (err) { App.fail(err, 'Not done'); }
      });
    }
  });

  // "/" opens the search screen from anywhere (not while typing; off with single-key shortcuts off, WCAG 2.1.4).
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
    const el = document.activeElement;
    if (el && (/input|textarea|select/i.test(el.tagName) || el.isContentEditable)) return;
    if (!App.state || !App.state.signedIn || App.state.singleKeys === false || document.getElementById('overlay')) return;
    e.preventDefault();
    if (App.state.route === ID) { const i = document.getElementById('search-q'); if (i) i.focus(); return; }
    App.navigate(ID);
    setTimeout(() => { const i = document.getElementById('search-q'); if (i) i.focus(); }, 60);
  });
})();
