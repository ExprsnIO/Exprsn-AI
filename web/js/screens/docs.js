// Docs (1.9.x): documentation sites built from knowledge bases. A site is a set of chosen bases; its pages are their
// references (curated Markdown with slugs, versions and a page tree) and, optionally, a Library of the bases' other
// documents grouped by category. The server renders pages to safe HTML and answers only what the reader may read.
//   #/docs                          the person's sites (opens the last site read, unless ?all=1)
//   #/docs?site=<slug>              a site, on its home page
//   #/docs?site=<slug>&kb=<id>&page=<refSlug>[&version=<v>]   a page
//   #/docs?site=<slug>&lib=<kbId>[&cat=<path>]                a Library listing
//   #/docs?site=<slug>&doc=<docId>                             a Library document
(function () {
  const { UI, esc } = App;
  const enc = encodeURIComponent;
  const day = (t) => { if (!t) return ''; const d = new Date(t); return isNaN(d) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); };
  const href = (params) => '#/docs' + (function () { const q = Object.keys(params).filter((k) => params[k] != null && params[k] !== '').map((k) => k + '=' + enc(params[k])).join('&'); return q ? '?' + q : ''; })();
  const slugify = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  const STATE = { draft: 'Draft', 'in-review': 'In review', approved: 'Publishing', published: 'Published', superseded: 'Superseded', rejected: 'Rejected', withdrawn: 'Withdrawn', retired: 'Retired' };
  const TONE = { draft: '', 'in-review': 'warn', approved: 'info', published: 'ok', superseded: '', rejected: 'danger', withdrawn: '', retired: '' };
  const statePill = (s) => UI.pill(STATE[s] || s, TONE[s] != null ? TONE[s] || 'outline' : 'outline');
  const lastSeg = (p) => String(p || '').split('/').filter(Boolean).pop() || p;
  const who = (x) => (!x ? '' : typeof x === 'string' ? x : x.name || x.username || '');
  const MISSING = 'That page does not exist or you cannot read it.';

  // The last site a person read, per person, only to open #/docs on it next time.
  const lastKey = () => 'exprsn.docs.lastSite.' + ((App.me && App.me.user && App.me.user.id) || 'me');
  const getLast = () => { try { return localStorage.getItem(lastKey()) || null; } catch (e) { return null; } };
  const setLast = (slug) => { try { if (slug) localStorage.setItem(lastKey(), slug); else localStorage.removeItem(lastKey()); } catch (e) { /* storage unavailable */ } };

  let observer = null;   // highlights the heading in view in "On this page"
  let qTimer = null;     // debounces the site search
  let qSeq = 0;

  const CSS = [
    '#main .docs-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,280px),1fr));gap:12px}',
    '#main .docs-card{display:flex;flex-direction:column;gap:8px;margin:0}',
    '#main .docs-card h2{font-size:16px;margin:0;line-height:1.3}',
    '#main .docs-card h2 a{color:var(--fg);text-decoration:none}#main .docs-card h2 a:hover,#main .docs-card h2 a:focus-visible{text-decoration:underline}',
    '#main .docs-card p{margin:0;color:var(--fg2);font-size:13px}',
    '#main .docs-small{font-size:12px;color:var(--muted)}',
    '#main .docs-card .docs-acts{display:flex;gap:6px;flex-wrap:wrap;margin-top:auto}',
    '#main .docs-left{gap:6px}',
    '#main .docs-back{font-size:12px;color:var(--fg2)}',
    '#main .docs-sitetitle{font-size:15px;font-weight:700;margin:0 0 4px;color:var(--fg);overflow-wrap:anywhere}',
    '#main .docs-left h2{margin:10px 0 2px}',
    '#main .docs-left .search{width:100%}',
    '#main .docs-tree,#main .docs-cats,#main .docs-hits ul,#main .docs-linklist,#main .docs-doclist,#main .docs-toc ul{list-style:none;margin:0;padding:0}',
    '#main .docs-tree .docs-tree,#main .docs-cats .docs-cats{padding-left:14px}',
    '#main .docs-node{display:flex;align-items:center;gap:2px;min-width:0}',
    '#main .docs-twist{flex-shrink:0;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:0;border-radius:4px;background:transparent;color:var(--fg2);cursor:pointer;padding:0}',
    '#main .docs-twist:hover{background:var(--sel);color:var(--fg)}',
    '#main .docs-twist-sp{flex-shrink:0;width:24px}',
    '#main .docs-link{flex-grow:1;min-width:0;display:block;padding:4px 6px;border-radius:5px;color:var(--fg);text-decoration:none;font-size:13px;line-height:1.35;overflow-wrap:anywhere}',
    '#main .docs-link:hover{background:var(--sel)}',
    '#main .docs-link[aria-current="page"]{background:var(--accent-tint);font-weight:600}',
    '#main .docs-node .pill{flex-shrink:0;font-size:10px}',
    '#main .docs-count{margin-left:auto;padding-left:6px;font-size:11px;color:var(--muted)}',
    '#main .docs-libhead{display:flex;align-items:center;gap:4px;width:100%;border:0;background:transparent;padding:4px 2px;border-radius:5px;color:var(--fg);font:inherit;font-size:13px;font-weight:600;cursor:pointer;text-align:left}',
    '#main .docs-libhead:hover{background:var(--sel)}',
    '#main .docs-hit{display:flex;flex-direction:column;gap:1px;padding:6px;border-radius:5px;color:var(--fg);text-decoration:none}',
    '#main .docs-hit:hover,#main .docs-hit:focus-visible{background:var(--sel)}',
    '#main .docs-hit .t{font-size:13px;font-weight:600}#main .docs-hit .h{font-size:12px;color:var(--fg2)}#main .docs-hit .s{font-size:12px;color:var(--muted)}',
    '#main .docs-main{gap:10px}',
    '#main .docs-crumbs ol{list-style:none;display:flex;flex-wrap:wrap;gap:4px;margin:0;padding:0;font-size:12px;color:var(--muted)}',
    '#main .docs-crumbs li+li::before{content:"/";margin-right:4px;color:var(--faint)}',
    '#main .docs-crumbs a{color:var(--fg2)}',
    '#main .docs-titlebar h1{margin:0;font-size:24px;line-height:1.25;overflow-wrap:anywhere}',
    '#main .docs-meta{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px;font-size:12px;color:var(--muted)}',
    '#main .docs-version{display:flex;flex-wrap:wrap;align-items:flex-end;gap:10px}#main .docs-version .field{margin:0;min-width:min(100%,220px)}',
    '#main .docs-article{max-width:48rem;min-width:0;font-size:15px;line-height:1.65;color:var(--fg);overflow-wrap:break-word}',
    '#main .docs-article > :first-child{margin-top:0}',
    '#main .docs-article h1,#main .docs-article h2,#main .docs-article h3,#main .docs-article h4,#main .docs-article h5,#main .docs-article h6{line-height:1.3;margin:1.5em 0 .5em;scroll-margin-top:12px}',
    '#main .docs-article h1{font-size:1.6em}#main .docs-article h2{font-size:1.35em;padding-bottom:4px;border-bottom:1px solid var(--line)}#main .docs-article h3{font-size:1.15em}#main .docs-article h4,#main .docs-article h5,#main .docs-article h6{font-size:1em}',
    '#main .docs-article [tabindex="-1"]:focus{outline:2px solid var(--accent);outline-offset:2px}',
    '#main .docs-article p,#main .docs-article ul,#main .docs-article ol,#main .docs-article dl,#main .docs-article blockquote,#main .docs-article pre,#main .docs-article .tablewrap{margin:0 0 1em}',
    '#main .docs-article ul,#main .docs-article ol{padding-left:1.5em}#main .docs-article li+li{margin-top:.25em}#main .docs-article li > ul,#main .docs-article li > ol{margin:.25em 0 0}',
    '#main .docs-article code{font-family:var(--mono);font-size:.88em;background:var(--panel2);border:1px solid var(--line);border-radius:4px;padding:0 .3em}',
    '#main .docs-article pre{overflow-x:auto;max-width:100%;background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:10px 12px;line-height:1.5}',
    '#main .docs-article pre code{background:none;border:0;padding:0;font-size:13px;white-space:pre}',
    '#main .docs-article blockquote{border-left:3px solid var(--line2);margin-left:0;padding:2px 0 2px 12px;color:var(--fg2)}',
    '#main .docs-article .tablewrap{max-width:100%}',
    '#main .docs-article table{border-collapse:collapse;min-width:100%;font-size:14px}',
    '#main .docs-article th,#main .docs-article td{border-bottom:1px solid var(--line);padding:6px 10px;text-align:left;vertical-align:top}',
    '#main .docs-article th{background:var(--panel2);font-weight:600}',
    '#main .docs-article img{max-width:100%;height:auto}',
    '#main .docs-article hr{border:0;border-top:1px solid var(--line);margin:1.5em 0}',
    '#main .docs-article a[data-docs-missing]{color:var(--danger-fg);text-decoration-style:dotted}',
    '#main .docs-related{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr));gap:12px;max-width:48rem;border-top:1px solid var(--line);padding-top:12px}',
    '#main .docs-related h2{margin:0 0 4px}',
    '#main .docs-linklist li{padding:2px 0;font-size:13px}',
    '#main .docs-doclist li{padding:8px 0;border-bottom:1px solid var(--line)}',
    '#main .docs-doclist a{font-weight:600}',
    '#main .docs-toc h2{margin:0}',
    '#main .docs-toc button{display:block;width:100%;text-align:left;border:0;background:transparent;font:inherit;font-size:13px;line-height:1.35;color:var(--fg2);padding:4px 6px;border-left:2px solid transparent;cursor:pointer;overflow-wrap:anywhere}',
    '#main .docs-toc button:hover{color:var(--fg);background:var(--sel)}',
    '#main .docs-toc button.on{color:var(--fg);border-left-color:var(--accent);font-weight:600}',
    '#main .docs-toc .l3{padding-left:18px}#main .docs-toc .l4{padding-left:30px}#main .docs-toc .l5,#main .docs-toc .l6{padding-left:42px}',
    '#main .docs-fs{border:1px solid var(--line);border-radius:6px;padding:8px 10px;margin:0 0 12px;display:flex;flex-direction:column;gap:4px;max-height:220px;overflow-y:auto}',
    '#main .docs-fs legend{font-size:12px;font-weight:600;padding:0 4px}',
    '.modal .docs-fs{border:1px solid var(--line);border-radius:6px;padding:8px 10px;margin:0 0 12px;display:flex;flex-direction:column;gap:4px;max-height:220px;overflow-y:auto;min-width:0}',
    '.modal .docs-fs legend{font-size:12px;font-weight:600;padding:0 4px}'
  ].join('');

  // ---- Example content for the design states (the accessibility suite applies them on an empty server) ----
  const DEMO_KB = { id: 'kb-example', name: 'Product handbook', label: 'internal' };
  const DEMO_NAV = {
    site: { id: 'site-example', slug: 'example', title: 'Example site', description: 'How documentation sites read.', bases: [DEMO_KB], home: { kbId: DEMO_KB.id, slug: 'getting-started' }, library: true, canManage: false },
    sections: [{
      kb: DEMO_KB, duties: { edit: true, approve: false, manage: false },
      pages: [
        { id: 'p1', slug: 'getting-started', title: 'Getting started', parentId: null, position: 0, children: 2, state: 'published', version: '1.2.0' },
        { id: 'p2', slug: 'getting-started/sign-in', title: 'Signing in', parentId: 'p1', position: 0, children: 0, state: 'published', version: '1.0.1' },
        { id: 'p3', slug: 'getting-started/workspaces', title: 'Workspaces', parentId: 'p1', position: 1, children: 0, state: 'in-review', version: '0.9.0' },
        { id: 'p4', slug: 'questions', title: 'Questions and answers', parentId: null, position: 1, children: 0, state: 'published', version: '2.0.0' }
      ],
      library: { documents: 7, categories: [{ path: 'guides', depth: 0, documents: 5 }, { path: 'guides/administration', depth: 1, documents: 2 }, { path: 'policies', depth: 0, documents: 2 }] }
    }]
  };
  const DEMO_PAGE = {
    page: { id: 'p1', kbId: DEMO_KB.id, kb: DEMO_KB.name, slug: 'getting-started', title: 'Getting started', version: '1.2.0', label: 'internal', state: 'published', updatedAt: Date.now() - 86400000 * 3, approvedAt: Date.now() - 86400000 * 3, approvedBy: { name: 'A curator' } },
    html: '<p>A documentation site shows the published references of its knowledge bases as pages. This page is an example of how one reads.</p>'
      + '<h2 id="before-you-start">Before you start</h2><p>You read what your knowledge access and clearance allow. Pages you cannot read do not appear in the tree.</p>'
      + '<ul><li>Pick a page in the tree on the left.</li><li>Use <code>On this page</code> to jump to a section.</li></ul>'
      + '<h3 id="links">Links between pages</h3><p>See <a href="#/docs?site=example&amp;kb=kb-example&amp;page=getting-started%2Fsign-in" data-docs-kb="kb-example" data-docs-page="getting-started/sign-in">Signing in</a>. A link to a page you cannot read looks like <a href="#/docs?site=example&amp;kb=kb-example&amp;page=retired" data-docs-kb="kb-example" data-docs-page="retired" data-docs-missing="">this one</a>.</p>'
      + '<h2 id="an-example">An example request</h2><pre><code>curl -s https://exprsn.local/api/docs/sites/example/page?kb=kb-example&amp;slug=getting-started -H "accept: application/json"</code></pre>'
      + '<blockquote><p>Each page keeps its earlier versions; pick one under Version to read it.</p></blockquote>'
      + '<table><thead><tr><th>Part</th><th>Comes from</th></tr></thead><tbody><tr><td>Pages</td><td>The references of the site\'s knowledge bases</td></tr><tr><td>Library</td><td>Their other documents, by category</td></tr></tbody></table>',
    toc: [{ level: 2, id: 'before-you-start', text: 'Before you start' }, { level: 3, id: 'links', text: 'Links between pages' }, { level: 2, id: 'an-example', text: 'An example request' }],
    breadcrumbs: [{ slug: 'getting-started', title: 'Getting started' }],
    children: [{ slug: 'getting-started/sign-in', title: 'Signing in' }, { slug: 'getting-started/workspaces', title: 'Workspaces' }],
    links: [{ slug: 'getting-started/sign-in', title: 'Signing in' }],
    backlinks: [{ slug: 'questions', title: 'Questions and answers' }],
    versions: [{ version: '1.2.0', number: 3, state: 'published', at: Date.now() - 86400000 * 3, summary: 'Added the example request' }, { version: '1.1.0', number: 2, state: 'superseded', at: Date.now() - 86400000 * 30, summary: 'Links between pages' }],
    canEdit: false
  };
  const DEMO_HITS = [
    { kind: 'page', kbId: DEMO_KB.id, slug: 'getting-started/sign-in', title: 'Signing in', heading: 'With a passkey', snippet: 'Sign in with a passkey or a password and an authenticator.' },
    { kind: 'document', kbId: DEMO_KB.id, docId: 'doc-example', title: 'Sign-in policy', heading: 'Second factor', snippet: 'A second factor is required for administrators.' }
  ];

  App.register({
    id: 'docs', title: 'Docs', live: true, summary: 'Documentation sites built from knowledge bases',
    crumb: (st) => ['Docs'].concat(st.nav && st.nav.data ? [st.nav.data.site.title] : []),
    states: [
      { title: 'No sites', tone: 'neutral', text: 'Nobody has made a documentation site yet, or none is readable to this person.', apply(ctx) { ctx.state.demo = 'nosites'; ctx.state.demoHash = location.hash; ctx.rerender(); } },
      { title: 'Reading a page', tone: 'info', text: 'A page of a site: the page tree, the page with its version and links, and On this page.', apply(ctx) { ctx.state.demo = 'page'; ctx.state.demoHash = location.hash; ctx.rerender(); } },
      { title: 'Search results', tone: 'info', text: 'A search of the site replaces the tree with its results until the search is cleared.', apply(ctx) { ctx.state.demo = 'search'; ctx.state.demoHash = location.hash; ctx.rerender(); } },
      { title: 'Page not readable', tone: 'warn', text: 'The page does not exist or the reader may not read it.', apply(ctx) { ctx.state.demo = 'missing'; ctx.state.demoHash = location.hash; ctx.rerender(); } },
      { title: 'Site settings', tone: 'neutral', text: 'The dialog that makes or changes a site: title, address, knowledge bases, Library and home page.', apply(ctx) { siteDialog(ctx, null); } }
    ],
    render(root, ctx) {
      const st = ctx.state, p = ctx.params;
      if (observer) { observer.disconnect(); observer = null; }
      if (st.demo && st.demoHash !== location.hash) st.demo = null;
      st.open = st.open || {};
      const later = () => { if (App.state.route !== 'docs') return; if (document.querySelector('.overlay')) { setTimeout(later, 250); return; } ctx.rerender(); };
      st.later = later;
      const demoSite = st.demo && st.demo !== 'nosites';
      const slug = demoSite ? 'example' : p.site;
      if (!slug) return renderHome(root, ctx);
      renderSite(root, ctx, slug);
    }
  });

  // ---------------------------------------------------------------- Sites home
  function renderHome(root, ctx) {
    const st = ctx.state, p = ctx.params;
    st.nav = null; st.page = null; st.doc = null; st.lib = null;
    if (!p.all && !st.demo) {
      const last = getLast();
      if (last) { location.replace(href({ site: last })); root.innerHTML = '<div class="page">' + UI.notice('Opening the site you read last…', 'info') + '</div>'; return; }
    }
    if (!st.loaded && !st.sitesLoading && !st.demo) {
      st.sitesLoading = true;
      App.get('/api/docs/sites').then((s) => { st.sites = Array.isArray(s) ? s : []; st.sitesErr = null; })
        .catch((err) => { st.sitesErr = err; })
        .finally(() => { st.sitesLoading = false; st.loaded = true; st.later(); });
    }
    const manager = App.can('docs:manage');
    const newBtn = manager ? UI.btn('New site', { kind: 'primary', icon: 'plus', attrs: 'data-docsnew' }) : '';
    let body;
    const sites = st.demo === 'nosites' ? [] : st.sites;
    if (st.demo !== 'nosites' && st.sitesErr) body = UI.problem('Documentation sites could not be loaded', st.sitesErr.message, st.sitesErr.problem && st.sitesErr.problem.trace_id) + '<div>' + UI.btn('Try again', { attrs: 'data-docsreload' }) + '</div>';
    else if (st.demo !== 'nosites' && (!st.loaded || !sites)) body = UI.notice('Loading…', 'info');
    else if (!sites.length) body = UI.empty('No documentation sites yet', manager ? 'A site gathers the published references of chosen knowledge bases into pages people can read, with a Library of their other documents if you want one.' : 'A site gathers the published references of knowledge bases into pages to read. Ask a knowledge curator to publish one.', newBtn);
    else body = '<div class="docs-cards">' + sites.map((s) => '<article class="panel docs-card" data-docssite="' + esc(s.slug) + '">'
      + '<h2><a href="' + esc(href({ site: s.slug })) + '">' + esc(s.title) + '</a></h2>'
      + (s.description ? '<p>' + esc(s.description) + '</p>' : '')
      + '<div class="docs-small">Knowledge bases: ' + (s.bases && s.bases.length ? s.bases.map((b) => esc(b.name)).join(', ') : 'none you can read') + '</div>'
      + '<div class="docs-small">' + (s.library ? 'Pages and a Library. ' : 'Pages. ') + (s.updatedAt ? 'Updated ' + esc(day(s.updatedAt)) + '.' : '') + '</div>'
      + (s.canManage ? '<div class="docs-acts">' + UI.btn('Settings', { size: 'sm', attrs: 'data-docsset="' + esc(s.id) + '" aria-label="Settings of ' + esc(s.title) + '"' }) + UI.btn('Delete', { size: 'sm', kind: 'danger', attrs: 'data-docsdel="' + esc(s.id) + '" aria-label="Delete ' + esc(s.title) + '"' }) + '</div>' : '')
      + '</article>').join('') + '</div>';
    root.innerHTML = '<style>' + CSS + '</style><div class="page">' + UI.pagehead('Docs', 'Documentation sites built from knowledge bases. Each page follows your knowledge access and clearance.', sites && sites.length ? newBtn : '') + body + '</div>';
    ctx.on('click', '[data-docsreload]', () => { st.sitesErr = null; st.loaded = false; ctx.rerender(); });
    ctx.on('click', '[data-docsnew]', () => siteDialog(ctx, null));
    ctx.on('click', '[data-docsset]', (e, t) => { const s = (st.sites || []).find((x) => x.id === t.dataset.docsset); if (s) siteDialog(ctx, s); });
    ctx.on('click', '[data-docsdel]', async (e, t) => {
      const s = (st.sites || []).find((x) => x.id === t.dataset.docsdel); if (!s) return;
      if (!(await ctx.confirm({ title: 'Delete ' + s.title, tag: 'destructive', tone: 'danger', ok: 'Delete', body: '<div class="fg2">The site and its address go. Its knowledge bases, their references and documents stay as they are.</div>' }))) return;
      try {
        await App.del('/api/docs/sites/' + enc(s.id));
        if (getLast() === s.slug) setLast(null);
        st.sites = st.sites.filter((x) => x.id !== s.id);
        ctx.toast('<span>Deleted ' + esc(s.title) + '.</span>', 'ok', 5000);
        st.loaded = false; st.later();
      } catch (err) { App.fail(err); }
    });
  }

  // ---------------------------------------------------------------- New site / Settings
  async function siteDialog(ctx, site) {
    const st = ctx.state;
    let bases;
    try { bases = await App.get('/api/knowledge/bases'); } catch (err) { App.fail(err); return; }
    bases = Array.isArray(bases) ? bases : [];
    const chosen = {}; ((site && site.bases) || []).forEach((b) => { chosen[b.id] = true; });
    const homeVal = site && site.home ? site.home.kbId + '|' + site.home.slug : '';
    const refs = {};   // kbId -> [{slug,title}] | 'loading' | 'error'
    ctx.modal({
      title: site ? 'Settings of ' + esc(site.title) : 'New documentation site',
      body: '<style>' + CSS + '</style>'
        + UI.field('Title', UI.input(site ? site.title : '', { attrs: 'data-title autocomplete="off"' }))
        + UI.field('Address', UI.input(site ? site.slug : '', { attrs: 'data-slug autocomplete="off" spellcheck="false"' }), 'Lower-case letters, digits and hyphens. The site opens at #/docs?site= and this address.')
        + UI.field('Description', UI.textarea(site ? site.description || '' : '', { rows: 2, attrs: 'data-desc' }))
        + '<fieldset class="docs-fs"><legend>Knowledge bases</legend>' + (bases.length ? bases.map((b) => UI.check(b.name, !!chosen[b.id], 'data-kb="' + esc(b.id) + '"')).join('') : '<div class="docs-small">You cannot read any knowledge base yet.</div>') + '</fieldset>'
        + UI.check('Include a Library of the bases\' other documents (crawled pages and files)', site ? !!site.library : false, 'data-lib')
        + UI.field('Home page', UI.select([{ value: '', label: 'The first page of the first base' }], '', 'data-home'), 'The page the site opens on. Its pages are the bases\' published references.')
        + '<div data-err></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn(site ? 'Save' : 'Create site', { kind: 'primary', attrs: 'data-go' }),
      onMount(m) {
        const $ = (q) => m.querySelector(q);
        let slugTouched = !!site;
        $('[data-title]').addEventListener('input', () => { if (!slugTouched) $('[data-slug]').value = slugify($('[data-title]').value); });
        $('[data-slug]').addEventListener('input', () => { slugTouched = true; });
        const picked = () => Array.prototype.map.call(m.querySelectorAll('[data-kb]:checked'), (c) => c.dataset.kb);
        let want = homeVal;
        const fillHome = () => {
          const sel = $('[data-home]'); if (!sel) return;
          if (sel.value) want = sel.value;
          const ids = picked();
          const opts = [{ value: '', label: ids.length ? 'The first page of the first base' : 'Pick knowledge bases first' }];
          let waiting = false;
          ids.forEach((id) => {
            const b = bases.find((x) => x.id === id) || { name: id };
            if (refs[id] === 'loading') { waiting = true; return; }
            if (Array.isArray(refs[id])) refs[id].forEach((r) => opts.push({ value: id + '|' + r.slug, label: b.name + ': ' + r.title }));
          });
          if (waiting) opts.push({ value: '__wait', label: 'Reading the bases\' pages…' });
          sel.innerHTML = opts.map((o) => '<option value="' + esc(o.value) + '"' + (o.value === '__wait' ? ' disabled' : '') + (o.value === want ? ' selected' : '') + '>' + esc(o.label) + '</option>').join('');
          if (!opts.some((o) => o.value === want)) sel.value = '';
        };
        const loadRefs = () => {
          picked().forEach((id) => {
            if (refs[id]) return;
            refs[id] = 'loading';
            App.get('/api/knowledge/bases/' + enc(id) + '/references')
              .then((list) => { refs[id] = (Array.isArray(list) ? list : []).filter((r) => r.version || r.state === 'published').map((r) => ({ slug: r.slug, title: r.title || r.slug })); })
              .catch(() => { refs[id] = []; })
              .finally(fillHome);
          });
          fillHome();
        };
        m.querySelectorAll('[data-kb]').forEach((c) => c.addEventListener('change', loadRefs));
        $('[data-home]').addEventListener('change', () => { want = $('[data-home]').value; });
        loadRefs();
        $('[data-go]').addEventListener('click', async () => {
          const err = (t) => { $('[data-err]').innerHTML = UI.notice(esc(t), 'danger'); };
          const title = $('[data-title]').value.trim(), slug = $('[data-slug]').value.trim();
          const kbIds = picked();
          if (!title) return err('Give the site a title.');
          if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return err('The address takes lower-case letters, digits and single hyphens.');
          if (!kbIds.length) return err('Pick at least one knowledge base.');
          const hv = $('[data-home]').value;
          const body = { slug: slug, title: title, description: $('[data-desc]').value.trim(), kbIds: kbIds, library: $('[data-lib]').checked, home: hv && hv !== '__wait' ? { kbId: hv.slice(0, hv.indexOf('|')), slug: hv.slice(hv.indexOf('|') + 1) } : null };
          try {
            const r = site ? await App.patch('/api/docs/sites/' + enc(site.id), body) : await App.post('/api/docs/sites', body);
            App.closeOverlay();
            if (site && getLast() === site.slug && r && r.slug && r.slug !== site.slug) setLast(r.slug);
            ctx.toast('<span>' + (site ? 'Saved ' : 'Created ') + esc(title) + '.</span>', 'ok', 5000);
            st.loaded = false; st.nav = null;
            if (st.later) st.later();
          } catch (e2) { const pr = e2.problem || {}; $('[data-err]').innerHTML = UI.notice('<b>' + esc(pr.title || 'Refused') + '.</b> ' + esc(e2.message), 'danger'); }
        });
      }
    });
  }

  // ---------------------------------------------------------------- A site
  function renderSite(root, ctx, slug) {
    const st = ctx.state, p = ctx.params;
    const demo = st.demo;
    // The site's navigation, refetched whenever the site is opened from the sites list.
    if (!demo && (!st.nav || st.nav.slug !== slug)) {
      st.nav = { slug: slug, loading: true }; st.q = ''; st.hits = null;
      App.get('/api/docs/sites/' + enc(slug) + '/nav')
        .then((d) => { if (st.nav && st.nav.slug === slug) { st.nav.data = d; setLast(slug); } })
        .catch((err) => { if (st.nav && st.nav.slug === slug) st.nav.error = err; if (err.status === 404 || (err.problem && err.problem.status === 404)) { if (getLast() === slug) setLast(null); } })
        .finally(() => { if (st.nav && st.nav.slug === slug) st.nav.loading = false; st.later(); });
    }
    const nav = demo ? DEMO_NAV : st.nav.data;
    const back = '<a class="docs-back" href="' + esc(href({ all: 1 })) + '">All sites</a>';
    if (!nav) {
      const e = st.nav && st.nav.error;
      root.innerHTML = '<style>' + CSS + '</style><div class="page">' + back
        + (e ? UI.problem(e.status === 404 ? 'This site does not exist or you cannot read it' : 'The site could not be loaded', e.message, e.problem && e.problem.trace_id) + '<div>' + UI.btn('Try again', { attrs: 'data-docsreload' }) + '</div>' : UI.notice('Loading…', 'info')) + '</div>';
      ctx.on('click', '[data-docsreload]', () => { st.nav = null; ctx.rerender(); });
      return;
    }
    const site = nav.site, sections = nav.sections || [];
    if (demo === 'search') { st.q = 'sign in'; st.hits = { q: 'sign in', hits: DEMO_HITS }; }

    // What the main pane shows.
    let view;
    if (demo === 'page' || demo === 'search') view = { kind: 'page', kb: DEMO_KB.id, page: 'getting-started' };
    else if (demo === 'missing') view = { kind: 'page', kb: DEMO_KB.id, page: 'retired' };
    else if (p.doc) view = { kind: 'doc', doc: p.doc };
    else if (p.lib) view = { kind: 'lib', kb: p.lib, cat: p.cat || '' };
    else if (p.kb && p.page) view = { kind: 'page', kb: p.kb, page: p.page, version: p.version || '' };
    else {
      const first = sections.find((s) => (s.pages || []).length);
      const home = site.home && sections.some((s) => s.kb.id === site.home.kbId && (s.pages || []).some((x) => x.slug === site.home.slug)) ? site.home : null;
      if (home) view = { kind: 'page', kb: home.kbId, page: home.slug };
      else if (first) { const roots = first.pages.filter((x) => !x.parentId || !first.pages.some((y) => y.id === x.parentId)).sort((a, b) => (a.position || 0) - (b.position || 0)); view = { kind: 'page', kb: first.kb.id, page: (roots[0] || first.pages[0]).slug }; }
      else { const lib = sections.find((s) => s.library); view = lib ? { kind: 'lib', kb: lib.kb.id, cat: '' } : { kind: 'none' }; }
    }

    const fresh = (key) => { const sc = document.querySelector('#main .docs-main'); if (sc) sc.scrollTop = 0; const mn = document.querySelector('#main'); if (mn) mn.scrollTop = 0; window.scrollTo(0, 0); return key; };
    // Load what the view needs (one page, document or listing at a time).
    if (!demo && view.kind === 'page') {
      const key = [slug, view.kb, view.page, view.version].join('|');
      if (!st.page || st.page.key !== key) {
        st.page = { key: key, loading: true };
        App.get('/api/docs/sites/' + enc(slug) + '/page?kb=' + enc(view.kb) + '&slug=' + enc(view.page) + (view.version ? '&version=' + enc(view.version) : ''))
          .then((d) => { if (st.page && st.page.key === key) { st.page.data = d; fresh(key); } })
          .catch((err) => { if (st.page && st.page.key === key) st.page.error = err; })
          .finally(() => { if (st.page && st.page.key === key) st.page.loading = false; st.later(); });
      }
    }
    if (!demo && view.kind === 'doc') {
      const key = slug + '|' + view.doc;
      if (!st.doc || st.doc.key !== key) {
        st.doc = { key: key, loading: true };
        App.get('/api/docs/sites/' + enc(slug) + '/document/' + enc(view.doc))
          .then((d) => { if (st.doc && st.doc.key === key) { st.doc.data = d; st.doc.html = d.html || ''; st.doc.toc = d.toc || []; st.doc.next = d.next == null ? null : d.next; fresh(key); } })
          .catch((err) => { if (st.doc && st.doc.key === key) st.doc.error = err; })
          .finally(() => { if (st.doc && st.doc.key === key) st.doc.loading = false; st.later(); });
      }
    }
    if (!demo && view.kind === 'lib') {
      const key = [slug, view.kb, view.cat, st.libq || ''].join('|');
      if (!st.lib || st.lib.key !== key) {
        st.lib = { key: key, loading: true };
        App.get('/api/docs/sites/' + enc(slug) + '/library?kb=' + enc(view.kb) + (view.cat ? '&category=' + enc(view.cat) : '') + (st.libq ? '&q=' + enc(st.libq) : '') + '&limit=50')
          .then((d) => { if (st.lib && st.lib.key === key) st.lib.documents = (d && d.documents) || []; })
          .catch((err) => { if (st.lib && st.lib.key === key) st.lib.error = err; })
          .finally(() => { if (st.lib && st.lib.key === key) st.lib.loading = false; st.later(); });
      }
    }

    const sectionOf = (kbId) => sections.find((s) => s.kb.id === kbId) || null;
    const pageHref = (kbId, pslug, extra) => href(Object.assign({ site: slug, kb: kbId, page: pslug }, extra || {}));

    // ---- left pane: search, page trees, Library ----
    const tree = (sec) => {
      const pages = sec.pages || [];
      const ids = {}; pages.forEach((x) => { ids[x.id] = x; });
      const by = {};
      pages.forEach((x) => { const k = x.parentId && ids[x.parentId] ? x.parentId : ''; (by[k] = by[k] || []).push(x); });
      Object.keys(by).forEach((k) => by[k].sort((a, b) => (a.position || 0) - (b.position || 0) || String(a.title).localeCompare(String(b.title))));
      const curPage = view.kind === 'page' && view.kb === sec.kb.id ? pages.find((x) => x.slug === view.page) : null;
      const anc = {};
      for (let n = curPage && ids[curPage.parentId]; n; n = ids[n.parentId]) { anc[n.id] = true; if (anc[n.parentId]) break; }
      const list = (parent, depth) => '<ul class="docs-tree" role="list">' + (by[parent] || []).map((x) => {
        const kids = by[x.id] && by[x.id].length;
        const k = sec.kb.id + ':' + x.id;
        const open = st.open[k] != null ? st.open[k] : !!anc[x.id];
        const cur = curPage && curPage.id === x.id;
        return '<li><div class="docs-node">'
          + (kids ? '<button type="button" class="docs-twist" data-docstwist="' + esc(k) + '" aria-expanded="' + (open ? 'true' : 'false') + '" aria-label="Pages under ' + esc(x.title) + '">' + App.icon(open ? 'chevd' : 'chev', 14) + '</button>' : '<span class="docs-twist-sp" aria-hidden="true"></span>')
          + '<a class="docs-link" href="' + esc(pageHref(sec.kb.id, x.slug)) + '"' + (cur ? ' aria-current="page"' : '') + '>' + esc(x.title) + '</a>'
          + (x.state && x.state !== 'published' ? statePill(x.state) : '')
          + '</div>' + (kids && open && depth < 12 ? list(x.id, depth + 1) : '') + '</li>';
      }).join('') + '</ul>';
      return pages.length ? list('', 0) : '<p class="docs-small">No pages you can read in this base.</p>';
    };
    const library = (sec) => {
      const lib = sec.library; if (!lib) return '';
      const lk = 'lib:' + sec.kb.id;
      const here = view.kind === 'lib' && view.kb === sec.kb.id;
      const open = st.open[lk] != null ? st.open[lk] : here;
      const cats = lib.categories || [];
      const kidsOf = (c) => cats.filter((x) => x.depth === c.depth + 1 && x.path.indexOf(c.path + '/') === 0);
      const catList = (items) => '<ul class="docs-cats" role="list">' + items.map((c) => {
        const kids = kidsOf(c);
        const ck = lk + ':' + c.path;
        const copen = st.open[ck] != null ? st.open[ck] : !!(here && view.cat && (view.cat === c.path || view.cat.indexOf(c.path + '/') === 0));
        const cur = here && view.cat === c.path;
        return '<li><div class="docs-node">'
          + (kids.length ? '<button type="button" class="docs-twist" data-docstwist="' + esc(ck) + '" aria-expanded="' + (copen ? 'true' : 'false') + '" aria-label="Categories under ' + esc(lastSeg(c.path)) + '">' + App.icon(copen ? 'chevd' : 'chev', 14) + '</button>' : '<span class="docs-twist-sp" aria-hidden="true"></span>')
          + '<a class="docs-link" href="' + esc(href({ site: slug, lib: sec.kb.id, cat: c.path })) + '"' + (cur ? ' aria-current="page"' : '') + '>' + esc(lastSeg(c.path)) + ' <span class="docs-count">' + Number(c.documents || 0) + '</span></a>'
          + '</div>' + (kids.length && copen ? catList(kids) : '') + '</li>';
      }).join('') + '</ul>';
      const tops = cats.filter((c) => !cats.some((x) => x.depth === c.depth - 1 && c.path.indexOf(x.path + '/') === 0));
      return '<div class="docs-lib"><button type="button" class="docs-libhead" data-docstwist="' + esc(lk) + '" aria-expanded="' + (open ? 'true' : 'false') + '">' + App.icon(open ? 'chevd' : 'chev', 14) + '<span class="grow">Library</span><span class="docs-count">' + Number(lib.documents || 0) + '</span></button>'
        + (open ? '<ul class="docs-cats" role="list"><li><div class="docs-node"><span class="docs-twist-sp" aria-hidden="true"></span><a class="docs-link" href="' + esc(href({ site: slug, lib: sec.kb.id })) + '"' + (here && !view.cat ? ' aria-current="page"' : '') + '>All documents <span class="docs-count">' + Number(lib.documents || 0) + '</span></a></div></li></ul>' + (tops.length ? catList(tops) : '') : '')
        + '</div>';
    };
    const hitHref = (h) => (h.kind === 'document' ? href({ site: slug, doc: h.docId }) : pageHref(h.kbId, h.slug));
    let left;
    if (st.q) {
      const r = st.hits && st.hits.q === st.q ? st.hits : null;
      left = '<div class="docs-hits" role="region" aria-label="Search results">'
        + (r && r.error ? UI.notice('The search failed: ' + esc(r.error.message), 'danger')
          : !r ? '<p class="docs-small" role="status">Searching…</p>'
            : '<p class="docs-small" role="status">' + (r.hits.length ? r.hits.length + ' result' + (r.hits.length === 1 ? '' : 's') + ' for ' : 'No results for ') + '&ldquo;' + esc(r.q) + '&rdquo;' + (r.hits.length ? '' : '. Try other words, or clear the search to see the pages.') + '</p>'
              + '<ul role="list">' + r.hits.map((h, i) => '<li><a class="docs-hit" data-docshit="' + i + '" href="' + esc(hitHref(h)) + '"><span class="t">' + esc(h.title) + (h.kind === 'document' ? ' <span class="docs-small">Library</span>' : '') + '</span>' + (h.heading ? '<span class="h">' + esc(h.heading) + '</span>' : '') + (h.snippet ? '<span class="s">' + esc(h.snippet) + '</span>' : '') + '</a></li>').join('') + '</ul>')
        + '</div>';
    } else {
      left = '<nav aria-label="Pages of ' + esc(site.title) + '">' + (sections.length ? sections.map((sec) => '<h2 class="eyebrow">' + esc(sec.kb.name) + '</h2>' + tree(sec) + library(sec)).join('') : '<p class="docs-small">This site has no knowledge base you can read.</p>') + '</nav>';
    }
    const leftHtml = '<div class="leftpane docs-left">' + back + '<p class="docs-sitetitle">' + esc(site.title) + '</p>'
      + UI.search('Search this site', 'data-docsq autocomplete="off"', st.q || '') + left + '</div>';

    // ---- main and right panes ----
    let main = '', toc = null;
    const crumbs = (items) => '<nav class="docs-crumbs" aria-label="Where this page is in the site"><ol>' + items.map((c) => '<li>' + (c.href ? '<a href="' + esc(c.href) + '">' + esc(c.title) + '</a>' : '<span aria-current="page">' + esc(c.title) + '</span>') + '</li>').join('') + '</ol></nav>';
    const siteCrumb = { title: site.title, href: href({ site: slug }) };
    const problemOf = (e, what) => (e && (e.status === 404 || (e.problem && e.problem.status === 404))
      ? UI.empty(MISSING, 'It may have been retired, or it is above your clearance. Pick another page in the tree.', '<a href="' + esc(href({ site: slug })) + '">Go to the site\'s home page</a>')
      : UI.problem(what + ' could not be loaded', e ? e.message : '', e && e.problem && e.problem.trace_id) + '<div>' + UI.btn('Try again', { attrs: 'data-docsretry' }) + '</div>');
    if (view.kind === 'none') {
      main = UI.pagehead(site.title, site.description ? esc(site.description) : '', '') + UI.empty('Nothing to read here yet', 'This site has no pages you can read. Its pages are the published references of its knowledge bases; ask a curator to publish one or to give you access.');
    } else if (view.kind === 'page') {
      const pg = demo === 'missing' ? { error: { status: 404, message: MISSING } } : demo ? { data: DEMO_PAGE } : st.page;
      if (pg.error) main = crumbs([siteCrumb]) + problemOf(pg.error, 'The page');
      else if (!pg.data) main = crumbs([siteCrumb]) + UI.notice('Loading…', 'info');
      else {
        const d = pg.data, pp = d.page;
        const sec = sectionOf(pp.kbId);
        const versions = (d.versions || []).slice().sort((a, b) => (b.number || 0) - (a.number || 0));
        const current = versions.find((v) => v.state === 'published');
        const old = current && pp.version && pp.version !== current.version;
        const cs = [siteCrumb].concat((d.breadcrumbs || []).filter((c) => c.slug !== pp.slug).map((c) => ({ title: c.title, href: pageHref(pp.kbId, c.slug) }))).concat([{ title: pp.title }]);
        const meta = [];
        if (sec && sections.length > 1) meta.push('<span>' + esc(sec.kb.name) + '</span>');
        if (pp.version) meta.push('<span>Version ' + esc(pp.version) + '</span>');
        if (pp.updatedAt) meta.push('<span>Updated ' + esc(day(pp.updatedAt)) + '</span>');
        if (pp.approvedBy) meta.push('<span>Approved by ' + esc(who(pp.approvedBy)) + (pp.approvedAt ? ' on ' + esc(day(pp.approvedAt)) : '') + '</span>');
        if (pp.label) meta.push(UI.label(pp.label, { sm: true }));
        if (pp.state && pp.state !== 'published') meta.push(statePill(pp.state));
        const vsel = versions.length > 1 ? '<div class="docs-version">' + UI.field('Version', UI.select(versions.map((v) => ({ value: v.version, label: v.version + ' (' + (STATE[v.state] || v.state) + (v.at ? ', ' + day(v.at) : '') + ')' })), pp.version, 'data-docsversion')) + '</div>' : '';
        const rel = (title, items) => (items && items.length ? '<section><h2 class="eyebrow">' + title + '</h2><ul class="docs-linklist" role="list">' + items.map((x) => '<li><a href="' + esc(pageHref(pp.kbId, x.slug)) + '">' + esc(x.title) + '</a></li>').join('') + '</ul></section>' : '');
        const related = rel('In this section', d.children) + rel('This page links to', d.links) + rel('Linked from', d.backlinks);
        main = crumbs(cs)
          + '<div class="hstack wrap docs-titlebar"><h1 class="grow">' + esc(pp.title) + '</h1>' + (d.canEdit && App.canOpen('knowledge') ? UI.btn('Edit in Knowledge', { size: 'sm', icon: 'edit', attrs: 'data-docsedit' }) : '') + '</div>'
          + '<div class="docs-meta">' + meta.join('') + '</div>' + vsel
          + (old ? UI.notice('You are reading version ' + esc(pp.version) + '; the current version is ' + esc(current.version) + '.', 'warn', '<a href="' + esc(pageHref(pp.kbId, pp.slug)) + '">Read the current version</a>') : '')
          + '<article class="docs-article" data-docsart>' + (d.html || '<p class="docs-small">This page is empty.</p>') + '</article>'
          + (related ? '<div class="docs-related">' + related + '</div>' : '');
        toc = d.toc || [];
      }
    } else if (view.kind === 'doc') {
      const dd = st.doc;
      if (dd.error) main = crumbs([siteCrumb]) + problemOf(dd.error, 'The document');
      else if (!dd.data) main = crumbs([siteCrumb]) + UI.notice('Loading…', 'info');
      else {
        const doc = dd.data.doc;
        const cat = (doc.categories || [])[0];
        const cs = [siteCrumb, { title: 'Library', href: href({ site: slug, lib: doc.kbId }) }].concat(cat ? [{ title: lastSeg(cat), href: href({ site: slug, lib: doc.kbId, cat: cat }) }] : []).concat([{ title: doc.title || doc.name }]);
        const meta = [];
        if (doc.kb) meta.push('<span>' + esc(typeof doc.kb === 'string' ? doc.kb : doc.kb.name) + '</span>');
        if (doc.name && doc.title && doc.name !== doc.title) meta.push('<span class="mono">' + esc(doc.name) + '</span>');
        if (doc.updatedAt) meta.push('<span>Updated ' + esc(day(doc.updatedAt)) + '</span>');
        if (doc.source) meta.push('<span>' + esc(doc.source) + '</span>');
        if (doc.label) meta.push(UI.label(doc.label, { sm: true }));
        const safeUrl = doc.url && /^https?:\/\//i.test(doc.url) ? doc.url : null;
        main = crumbs(cs)
          + '<div class="hstack wrap docs-titlebar"><h1 class="grow">' + esc(doc.title || doc.name) + '</h1>' + (safeUrl ? '<a class="btn sm" href="' + esc(safeUrl) + '" rel="noopener noreferrer" target="_blank">' + App.icon('link', 14) + 'Open the source<span class="sr"> (opens in a new tab)</span></a>' : '') + '</div>'
          + '<div class="docs-meta">' + meta.join('') + '</div>'
          + '<article class="docs-article" data-docsart>' + (dd.html || '<p class="docs-small">This document has no text.</p>') + '</article>'
          + (dd.next != null ? '<div>' + UI.btn(dd.loadingMore ? 'Reading more…' : 'Load more', { attrs: 'data-docsmore', disabled: !!dd.loadingMore }) + '</div>' : '');
        toc = dd.toc || [];
      }
    } else if (view.kind === 'lib') {
      const sec = sectionOf(view.kb);
      const cs = [siteCrumb, { title: 'Library' + (sec && sections.length > 1 ? ' of ' + sec.kb.name : ''), href: view.cat ? href({ site: slug, lib: view.kb }) : null }].concat(view.cat ? [{ title: lastSeg(view.cat) }] : []);
      const cat = sec && sec.library ? (sec.library.categories || []).find((c) => c.path === view.cat) : null;
      const total = view.cat ? (cat ? cat.documents : null) : sec && sec.library ? sec.library.documents : null;
      const lb = st.lib || {};
      let listHtml;
      if (lb.error) listHtml = problemOf(lb.error, 'The Library');
      else if (!lb.documents) listHtml = UI.notice('Loading…', 'info');
      else if (!lb.documents.length) listHtml = UI.empty(st.libq ? 'No documents match' : 'No documents here', st.libq ? 'Try other words, or clear the filter.' : 'This category has no documents you can read.');
      else listHtml = '<ul class="docs-doclist" role="list">' + lb.documents.map((x) => '<li><a href="' + esc(href({ site: slug, doc: x.id })) + '">' + esc(x.title || x.name) + '</a><div class="docs-small">' + [x.name && x.title && x.name !== x.title ? esc(x.name) : '', (x.categories || []).map((c) => esc(c)).join(', '), x.updatedAt ? 'updated ' + esc(day(x.updatedAt)) : '', x.source ? esc(x.source) : ''].filter(Boolean).join(' · ') + (x.label ? ' ' + UI.label(x.label, { sm: true }) : '') + '</div></li>').join('') + '</ul>'
        + (lb.documents.length >= 50 ? '<p class="docs-small">Showing the first 50. Filter to find others.</p>' : '');
      main = crumbs(cs) + '<div class="docs-titlebar"><h1>' + esc(view.cat ? lastSeg(view.cat) : 'Library') + '</h1></div>'
        + '<div class="docs-meta">' + (total != null ? '<span>' + Number(total) + ' document' + (Number(total) === 1 ? '' : 's') + '</span>' : '') + (view.cat ? '<span class="mono">' + esc(view.cat) + '</span>' : '<span>Crawled pages and files of ' + esc(sec ? sec.kb.name : 'this base') + '</span>') + '</div>'
        + '<div style="max-width:24rem">' + UI.field('Filter documents', UI.input(st.libq || '', { type: 'search', attrs: 'data-docslibq autocomplete="off"' }), 'Press Enter to filter.') + '</div>' + listHtml;
    }

    const tocHtml = toc ? '<aside class="inspector w300 docs-toc" aria-label="On this page"><h2 class="eyebrow">On this page</h2>'
      + (toc.length ? '<ul role="list">' + toc.map((t) => '<li><button type="button" class="l' + Math.min(6, Math.max(1, Number(t.level) || 2)) + '" data-toc="' + esc(t.id) + '">' + esc(t.text) + '</button></li>').join('') + '</ul>' : '<p class="docs-small">This page has no sections.</p>') + '</aside>' : '';
    root.innerHTML = '<style>' + CSS + '</style>' + leftHtml + '<div class="page docs-main">' + main + '</div>' + tocHtml;

    // Tables in the page scroll sideways inside their own box, never the page.
    root.querySelectorAll('[data-docsart] table').forEach((t) => {
      if (t.parentElement && t.parentElement.classList.contains('tablewrap')) return;
      const w = document.createElement('div'); w.className = 'tablewrap bare'; w.setAttribute('data-scroll-x', '');
      t.parentNode.insertBefore(w, t); w.appendChild(t);
    });

    // Highlight the heading in view.
    const art = root.querySelector('[data-docsart]');
    if (art && toc && toc.length && 'IntersectionObserver' in window) {
      const btns = {}; root.querySelectorAll('[data-toc]').forEach((b) => { btns[b.dataset.toc] = b; });
      const heads = toc.map((t) => art.querySelector('[id="' + (window.CSS && CSS.escape ? CSS.escape(t.id) : t.id) + '"]')).filter(Boolean);
      const seen = {};
      observer = new IntersectionObserver((entries) => {
        entries.forEach((en) => { seen[en.target.id] = en.isIntersecting; });
        const first = heads.find((h) => seen[h.id]);
        if (!first) return;
        Object.keys(btns).forEach((id) => { btns[id].classList.toggle('on', id === first.id); if (id === first.id) btns[id].setAttribute('aria-current', 'location'); else btns[id].removeAttribute('aria-current'); });
      }, { rootMargin: '0px 0px -60% 0px' });
      heads.forEach((h) => observer.observe(h));
    }
    // After following a link in the page or a search result, focus moves to the new page's title.
    if (st.focusTitle && root.querySelector('.docs-titlebar h1')) {
      st.focusTitle = false;
      const h = root.querySelector('.docs-titlebar h1');
      setTimeout(() => { if (h.isConnected && !document.querySelector('.overlay')) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); } }, 0);
    }

    // ---- handlers ----
    ctx.on('click', '[data-docsreload],[data-docsretry]', () => { if (view.kind === 'page') st.page = null; else if (view.kind === 'doc') st.doc = null; else if (view.kind === 'lib') st.lib = null; ctx.rerender(); });
    ctx.on('click', '[data-docstwist]', (e, t) => { const k = t.dataset.docstwist; st.open[k] = t.getAttribute('aria-expanded') !== 'true'; ctx.rerender(); });
    ctx.on('click', '[data-docsart] a[data-docs-page]', (e, t) => {
      e.preventDefault();
      if (t.hasAttribute('data-docs-missing')) { ctx.toast('<span>' + esc(MISSING) + '</span>', 'warn', 5000); return; }
      st.focusTitle = true;
      ctx.navigate('docs', { site: slug, kb: t.getAttribute('data-docs-kb') || view.kb, page: t.getAttribute('data-docs-page') });
    });
    ctx.on('click', '[data-toc]', (e, t) => {
      const a = root.querySelector('[data-docsart]'); if (!a) return;
      const el = a.querySelector('[id="' + (window.CSS && CSS.escape ? CSS.escape(t.dataset.toc) : t.dataset.toc) + '"]'); if (!el) return;
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
      el.scrollIntoView({ block: 'start' });
      el.focus({ preventScroll: true });
    });
    ctx.on('change', '[data-docsversion]', (e, t) => {
      const d = st.page && st.page.data; if (!d) return;
      const cur = (d.versions || []).find((v) => v.state === 'published');
      const extra = cur && t.value === cur.version ? {} : { version: t.value };
      ctx.navigate('docs', Object.assign({ site: slug, kb: d.page.kbId, page: d.page.slug }, extra));
    });
    ctx.on('click', '[data-docsedit]', () => {
      const d = st.page && st.page.data; if (!d) return;
      // The Knowledge screen opens on the base named by ?kb and keeps its tab in its own state: the References tab.
      App.stateFor('knowledge').tab = 'references';
      ctx.navigate('knowledge', { kb: d.page.kbId });
    });
    ctx.on('click', '[data-docsmore]', () => {
      const dd = st.doc; if (!dd || dd.next == null || dd.loadingMore) return;
      const key = dd.key;
      dd.loadingMore = true; ctx.rerender();
      App.get('/api/docs/sites/' + enc(slug) + '/document/' + enc(view.doc) + '?from=' + enc(dd.next))
        .then((r) => { if (st.doc && st.doc.key === key) { st.doc.html += r.html || ''; st.doc.toc = st.doc.toc.concat(r.toc || []); st.doc.next = r.next == null ? null : r.next; } })
        .catch((err) => App.fail(err))
        .finally(() => { if (st.doc && st.doc.key === key) st.doc.loadingMore = false; st.later(); });
    });
    ctx.on('keydown', '[data-docslibq]', (e, t) => { if (e.key === 'Enter') { e.preventDefault(); st.libq = t.value.trim(); ctx.rerender(); } });
    ctx.on('click', '[data-docshit]', () => { st.focusTitle = true; });

    // Search: debounced; results replace the tree while there is a query; Enter opens the first result.
    const runSearch = (q, openFirst) => {
      const seq = ++qSeq;
      if (demo) return;
      App.get('/api/docs/sites/' + enc(slug) + '/search?q=' + enc(q))
        .then((r) => { if (seq !== qSeq) return; st.hits = { q: q, hits: (r && r.hits) || [] }; if (openFirst && st.hits.hits[0]) { st.focusTitle = true; location.hash = hitHref(st.hits.hits[0]); } })
        .catch((err) => { if (seq === qSeq) st.hits = { q: q, hits: [], error: err }; })
        .finally(() => { if (seq === qSeq) st.later(); });
    };
    ctx.on('input', '[data-docsq]', (e, t) => {
      const q = t.value.trim();
      clearTimeout(qTimer);
      if (st.demo) { st.demo = null; }
      if (!q) { st.q = ''; st.hits = null; qSeq++; ctx.rerender(); return; }
      qTimer = setTimeout(() => { const was = st.q; st.q = q; if (!was) ctx.rerender(); runSearch(q, false); }, 250);
    });
    ctx.on('keydown', '[data-docsq]', (e, t) => {
      if (e.key === 'Escape' && t.value) { e.preventDefault(); clearTimeout(qTimer); t.value = ''; st.q = ''; st.hits = null; qSeq++; ctx.rerender(); return; }
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const q = t.value.trim(); if (!q) return;
      clearTimeout(qTimer);
      if (st.hits && st.hits.q === q && !st.hits.error) { if (st.hits.hits[0]) { st.focusTitle = true; location.hash = hitHref(st.hits.hits[0]); } return; }
      st.q = q; runSearch(q, true);
    });
  }
})();
