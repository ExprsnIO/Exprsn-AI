(function () {
  const { UI, esc } = App;

  // 1.7.0, Sprint 41d (B-12301): the catalogue, backed by GET /api/catalog: the workspace form of a conversation's
  // capabilities through one profile. Entries the profile's allow-list hides come back with `available: false` and the
  // profiles that offer them; entries above the person's clearance never come back. "Use in Chat" hands the entry to
  // the Chat screen (its state `fill`), which opens a new conversation with the composer filled in.
  const enc = encodeURIComponent;
  const KIND_HOW = {
    agent: 'Type @ in the composer, pick the agent, and say what it should do. A run starts bound to the conversation.',
    skill: 'Type + in the composer; the skill rides on the conversation until you remove it.',
    workflow: 'Type / in the composer and pick the workflow; its input is a short form.',
    tool: 'Type / in the composer, or let the model call it when it needs it.'
  };

  async function load(ctx, profile) {
    const st = ctx.state; st.loading = true; st.error = null;
    try {
      const data = await App.get('/api/catalog' + (profile ? '?profile=' + enc(profile) : ''));
      if (App.state.route !== 'catalog') return;
      st.data = data; st.profile = data.profile; st.loadedAt = Date.now();
    } catch (err) {
      // A profile that is no longer one the person may pick: list through the default one instead.
      if (profile && err.status === 404) { st.profile = null; st.loading = false; return load(ctx, null); }
      st.error = err;
    }
    st.loading = false;
    if (App.state.route === 'catalog') ctx.rerender();
  }

  /** Opens Chat on a new conversation with the composer holding the entry's call and an example prompt. */
  function useInChat(ctx, e, example) {
    const st = ctx.state;
    const compose = e.kind === 'agent' ? '@' + e.name + ': ' + (example || '') : e.call + ' ' + (example || '');
    App.stateFor('chat').fill = { key: e.key, kind: e.kind, name: e.name, call: e.call, compose, profile: (st.data && st.data.profile) || null, id: e.id };
    ctx.navigate('chat');
  }

  // Leaving the screen marks its list stale, so the next visit reads what was published meanwhile.
  window.addEventListener('hashchange', () => { if (!/^#\/catalog(\?|$)/.test(location.hash)) App.stateFor('catalog').stale = true; });

  App.register({
    id: 'catalog', title: 'Catalogue', summary: 'What you can do: the workflows, agents, tools and skills you may use here, by category, with how to call them', crumb: ['Catalogue'], live: true,
    commands: [{ label: 'Open the catalogue', sub: 'Catalogue', run(app) { app.navigate('catalog'); } }],
    // The states show what the screen does with the person's own data; none of them changes anything.
    states: [
      { title: 'Newly published', tone: 'info', text: 'A notice links here: the entry is selected and highlighted, and its card says how to call it.', apply(ctx) { const e = ((ctx.state.data && ctx.state.data.entries) || [])[0]; if (!e) { App.toast('Nothing is published to this workspace for you yet.'); return; } ctx.state.sel = e.key; ctx.state.fromNotice = true; ctx.rerender(); } },
      { title: 'Not on this profile', tone: 'warn', text: 'An entry the profile\'s allow-list hides is listed as "not on this profile" with the profiles that offer it; switching profile makes it callable.', apply(ctx) { const st = ctx.state; st.hidden = true; const e = ((st.data && st.data.entries) || []).find((x) => !x.available); if (e) st.sel = e.key; else App.toast('Every entry is on this profile.'); ctx.rerender(); } },
      { title: 'Entry without examples', tone: 'neutral', text: 'An entry published before the catalogue fields existed is listed with what it has, under Other, and opens Chat with only its call filled in.', apply(ctx) { const e = ((ctx.state.data && ctx.state.data.entries) || []).find((x) => !x.example); if (e) ctx.state.sel = e.key; else App.toast('Every entry has an example prompt.'); ctx.rerender(); } },
      { title: 'Nothing published yet', tone: 'neutral', text: 'When nothing is published to the workspace for the person, the page says so.', apply(ctx) { ctx.state.forceEmpty = true; ctx.rerender(); } },
      { title: 'Above your clearance', tone: 'neutral', text: 'Entries above the person\'s clearance are never listed, not even as "not on this profile".', apply(ctx) { ctx.state.clearanceNote = true; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      if (st.kind === undefined) st.kind = 'all';
      if (st.hidden === undefined) st.hidden = true;
      if (ctx.params.entry) { st.sel = ctx.params.entry; st.fromNotice = true; delete ctx.params.entry; }
      // Fresh on every visit (what was published meanwhile), not on every re-render.
      if (!st.loading && !st.error && (!st.data || st.stale)) { st.stale = false; load(ctx, st.profile || null); }
      const data = st.data;
      if (!data) {
        root.innerHTML = '<div class="page">' + UI.pagehead('What you can do', 'Workflows, agents, tools and skills you may use in this workspace.', '') + (st.error ? UI.problem('The catalogue could not be loaded', st.error.message, st.error.problem && st.error.problem.trace_id) : UI.notice('Loading…', 'info')) + '</div>';
        return;
      }
      const q = (st.query || '').toLowerCase();
      const all = st.forceEmpty ? [] : data.entries;
      const list = all.filter((e) => (st.kind === 'all' || e.kind === st.kind) && (st.hidden || e.available) && (!q || (e.name + ' ' + (e.description || '') + ' ' + (e.purpose || '') + ' ' + e.examples.join(' ')).toLowerCase().indexOf(q) >= 0));
      const cats = []; list.forEach((e) => { if (cats.indexOf(e.category) < 0) cats.push(e.category); });
      const sel = all.find((e) => e.key === st.sel) || null;
      const ws = data.workspace ? data.workspace.name : 'this workspace';
      const counts = { available: all.filter((e) => e.available).length, off: all.filter((e) => !e.available).length };

      const cardHtml = (e) => '<div class="cat-card' + (e.available ? '' : ' off') + (sel && sel.key === e.key ? ' on' : '') + '" data-entry="' + esc(e.key) + '">'
        + '<div class="hstack wrap gap6"><h3 class="cat-h"><button type="button" class="cat-name" data-open="' + esc(e.key) + '">' + esc(e.name) + '</button></h3>' + UI.pill(e.kind, 'outline') + (e.sideEffect && e.sideEffect !== 'read' ? UI.pill(e.sideEffect, 'warn') : '') + (st.fromNotice && sel && sel.key === e.key ? UI.pill('new', 'info') : '') + '<span class="right">' + UI.label(e.label, { sm: true }) + '</span></div>'
        + (e.description ? '<div class="fg2 cat-desc">' + esc(e.description) + '</div>' : '')
        + (e.example ? '<div class="cat-ex">"' + esc(e.example) + '"</div>' : '')
        + '<div class="hstack wrap gap6"><span class="mono cat-call">' + esc(e.call) + '</span>'
        + (e.available ? '<span class="right">' + UI.btn('Use in Chat', { size: 'sm', attrs: 'data-use="' + esc(e.key) + '" aria-label="Use ' + esc(e.name) + ' in Chat"', disabled: !App.can('chat:write') }) + '</span>'
          : '<span class="muted cat-off">Not on this profile. Offered by ' + e.profiles.map(esc).join(', ') + '</span><span class="right">' + UI.btn('Switch to ' + esc(e.profiles[0]), { size: 'sm', kind: 'ghost', attrs: 'data-switch="' + esc(e.profiles[0]) + '"' }) + '</span>')
        + '</div></div>';

      const inspector = sel ? '<aside class="inspector w320 cat-insp" aria-label="' + esc(sel.name) + '">'
        + '<div class="hstack wrap gap6"><h2 class="mono" style="font-size:14px;margin:0;overflow-wrap:anywhere">' + esc(sel.name) + '</h2>' + UI.pill(sel.kind, 'outline') + UI.label(sel.label, { sm: true }) + '</div>'
        + (st.fromNotice ? UI.notice('You were told about this one in a notice. Notices about new things you can use are set in Settings.', 'info') : '')
        + (sel.available ? '' : UI.notice('<b>Not on this profile.</b> ' + esc(data.profile || 'This profile') + '\'s allow-list leaves it out. ' + esc(sel.profiles.join(', ')) + ' offer' + (sel.profiles.length === 1 ? 's' : '') + ' it.', 'warn'))
        + UI.kv([['Call', '<span class="mono">' + esc(sel.call) + '</span>'], ['Category', esc(sel.category)], ['Purpose', sel.purpose ? esc(sel.purpose) : '<span class="muted">Not given</span>'], ['Version', '<span class="mono">' + esc(sel.version || 'current') + '</span>'], ['How to call it', esc(KIND_HOW[sel.kind] || '')]], 1)
        + '<div class="eyebrow">Example prompts</div>'
        + (sel.examples.length ? '<div class="vstack gap6">' + sel.examples.map((x, i) => '<div class="hstack gap6"><span class="grow cat-ex">"' + esc(x) + '"</span>' + (sel.available && App.can('chat:write') ? UI.btn('Use', { size: 'xs', attrs: 'data-useex="' + i + '" aria-label="Use the example: ' + esc(x) + '"' }) : '') + '</div>').join('') + '</div>' : '<div class="muted" style="font-size:12px">No example yet. Its owner can add some in the Registry.</div>')
        + '<div class="hstack">' + (sel.available ? UI.btn('Use in Chat', { kind: 'primary', attrs: 'data-use="' + esc(sel.key) + '"', disabled: !App.can('chat:write') }) : UI.btn('Switch to ' + esc(sel.profiles[0]), { kind: 'primary', attrs: 'data-switch="' + esc(sel.profiles[0]) + '"' })) + UI.btn('Close', { kind: 'ghost', attrs: 'data-closeinsp' }) + '</div>'
        + '</aside>' : '';

      root.innerHTML = '<style>'
        + '.cat-page > *{flex-shrink:0}.cat-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(260px,100%),1fr));gap:12px}'
        + '.cat-card{display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--line);border-radius:8px;background:var(--panel);min-width:0}.cat-card.on{border-color:var(--accent);background:var(--accent-tint)}.cat-card.off{background:var(--panel2)}'
        + '.cat-h{margin:0;font-size:inherit;min-width:0}.cat-name{all:unset;cursor:pointer;font-weight:600;overflow-wrap:anywhere}.cat-name:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.cat-desc{font-size:13px;overflow-wrap:anywhere}.cat-ex{font-size:13px;font-style:italic;color:var(--fg2);overflow-wrap:anywhere}.cat-call{font-size:12px;overflow-wrap:anywhere}.cat-off{font-size:12px}'
        + '.cat-head{display:flex;align-items:baseline;gap:8px;margin:18px 0 8px}.cat-head h2{font-size:15px;margin:0}.cat-insp > *{flex-shrink:0}'
        + '@media (max-width:900px){.cat-insp{display:none}}'
        + '</style>'
        + '<div class="page cat-page">' + UI.pagehead('What you can do', 'Workflows, agents, tools and skills you may use in <b>' + esc(ws) + '</b>' + (data.profile ? ' through profile <b>' + esc(data.profile) + '</b>' : '') + '. Pick one to open Chat with it filled in.', data.profiles.length ? '<span class="hstack gap6"><label class="sr" for="cat-profile">Profile</label>' + UI.select(data.profiles.map((p) => ({ value: p.name, label: p.displayName || p.name })), data.profile || '', 'id="cat-profile" data-profile') + '</span>' : '')
        + (st.clearanceNote ? UI.notice('Entries above your clearance (' + esc(data.clearance) + ') are never listed here, not even as "not on this profile".', 'info', UI.iconbtn('x', 'Dismiss', { cls: 'sm ghost', attrs: 'data-closenote' })) : '')
        + (!data.profiles.length ? UI.notice('No chat profile is published for your clearance, so tools and skills are not listed. Agents and workflows are.', 'info') : '')
        + '<div class="toolbar">' + UI.search('Search names, descriptions and examples', 'data-search', st.query) + UI.seg([{ id: 'all', label: 'All' }, { id: 'workflow', label: 'Workflows' }, { id: 'agent', label: 'Agents' }, { id: 'tool', label: 'Tools' }, { id: 'skill', label: 'Skills' }], st.kind, 'data-kind aria-label="Kind"') + UI.toggle('Show what this profile leaves out', st.hidden, 'data-hidden data-manual="1"') + '<span class="muted right" style="font-size:12px">' + counts.available + ' you can call, ' + counts.off + ' not on this profile</span></div>'
        + (all.length ? (list.length ? cats.map((c) => '<section aria-labelledby="cat-' + esc(c.replace(/[^\w-]/g, '-')) + '"><div class="cat-head"><h2 id="cat-' + esc(c.replace(/[^\w-]/g, '-')) + '">' + esc(c) + '</h2><span class="muted" style="font-size:12px">' + list.filter((e) => e.category === c).length + '</span></div><div class="cat-grid">' + list.filter((e) => e.category === c).map(cardHtml).join('') + '</div></section>').join('') : UI.empty('Nothing matches', 'Try another word, or show every kind.'))
          : UI.empty('Nothing published for you yet', 'When a workflow, agent, tool or skill is published to ' + esc(ws) + ' within your clearance, it shows here and you get a notice.'))
        + '</div>' + inspector;

      if (sel && st.scrollTo !== sel.key) { st.scrollTo = sel.key; const el = ctx.$('[data-entry="' + sel.key.replace(/"/g, '\\"') + '"]'); if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' }); }

      ctx.on('input', '[data-search]', (e, t) => { st.query = t.value; const v = t.value; ctx.rerender(); const i = ctx.$('[data-search]'); if (i) { i.focus(); i.setSelectionRange(v.length, v.length); } });
      ctx.on('click', '[data-kind] [data-seg]', (e, t) => { st.kind = t.dataset.seg; ctx.rerender(); });
      ctx.on('click', '[data-hidden]', () => { st.hidden = !st.hidden; ctx.rerender(); });
      ctx.on('change', '[data-profile]', (e, t) => { st.sel = null; load(ctx, t.value); });
      ctx.on('click', '[data-open]', (e, t) => { st.sel = t.dataset.open; st.fromNotice = false; ctx.rerender(); });
      ctx.on('click', '[data-closeinsp]', () => { st.sel = null; st.fromNotice = false; ctx.rerender(); });
      ctx.on('click', '[data-closenote]', () => { st.clearanceNote = false; ctx.rerender(); });
      ctx.on('click', '[data-switch]', async (e, t) => { await load(ctx, t.dataset.switch); App.toast('Listing what you can call through ' + esc(t.dataset.switch) + '.', 'ok'); });
      ctx.on('click', '[data-use]', (e, t) => { const x = all.find((y) => y.key === t.dataset.use); if (x) useInChat(ctx, x, x.example); });
      ctx.on('click', '[data-useex]', (e, t) => { if (sel) useInChat(ctx, sel, sel.examples[+t.dataset.useex]); });
    }
  });
})();
