// Workflows, Sprint 47 (Builders' tools, B-136): the template gallery (/api/workflow-templates). `workflows.js` shows
// the Templates view with App.wfTemplates(root, ctx, deps) when its state's `view` is "templates"
// (#/workflows?view=templates), and offers "Save as template" from the designer's toolbar through
// App.wfSaveTemplate(ctx, wf). deps.later() re-renders when a fetch lands, deps.back() returns to the designer and
// deps.openWorkflow(id) opens the workflow a template made. The view's state lives in ctx.state.tpl.
(function () {
  const { UI, esc } = App;
  const enc = encodeURIComponent;
  const LABELS = ['public', 'internal', 'confidential', 'restricted'];
  const ICONS = ['workflows', 'messages', 'calc', 'clock', 'roles', 'link', 'files', 'bell', 'knowledge', 'apps', 'connections', 'runs', 'flag', 'groups'];
  const KIND = { tool: 'Tool', profile: 'Profile', app: 'App', vault: 'Vault reference', decision: 'Decision table', role: 'Role', connection: 'Saved query', knowledge: 'Knowledge base', trigger: 'Trigger' };
  const OPT = { tool: 'tools', profile: 'profiles', app: 'apps', vault: 'vault', decision: 'decisions', role: 'roles', connection: 'connections', knowledge: 'knowledge' };
  const CSS = '.wftpl-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px}'
    + '.wftpl-card{display:flex;flex-direction:column;gap:6px;text-align:left;padding:12px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--fg);font-family:inherit;cursor:pointer;min-width:0}'
    + '.wftpl-card:hover{border-color:var(--muted)}.wftpl-card[aria-pressed="true"]{border:2px solid var(--accent);padding:11px}.wftpl-card:focus-visible{outline:2px solid var(--accent);outline-offset:2px}'
    + '.wftpl-card .t{font-weight:600;font-size:14px;overflow-wrap:anywhere}.wftpl-card .s{font-size:12px;color:var(--fg2);overflow-wrap:anywhere}.wftpl-sub{font-size:12px;color:var(--muted);overflow-wrap:anywhere}'
    + '.wftpl-graph{border:1px solid var(--line);border-radius:6px;background:var(--panel2);overflow:hidden}.wftpl-graph svg{display:block;width:100%;height:auto}'
    + '.wftpl-bind{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.3fr);gap:6px 10px;align-items:center;border-bottom:1px solid var(--line);padding:6px 0}.wftpl-bind .select{width:100%}'
    + '@media (max-width:560px){.wftpl-bind{grid-template-columns:minmax(0,1fr)}}';

  function state(ctx) { const st = ctx.state; st.tpl = st.tpl || { q: '', category: '', tag: '' }; return st.tpl; }

  function load(ctx, deps) {
    const t = state(ctx);
    t.loading = true;
    App.get('/api/workflow-templates')
      .then((d) => { t.data = d; t.error = null; })
      .catch((err) => { t.error = err; })
      .finally(() => { t.loading = false; deps.later(); });
  }
  function loadDetail(ctx, deps, id) {
    const t = state(ctx);
    t.detailLoading = id;
    App.get('/api/workflow-templates/' + enc(id))
      .then((d) => { if (t.selId === id) t.detail = d; })
      .catch((err) => { if (t.selId === id) t.detailError = err; })
      .finally(() => { t.detailLoading = null; deps.later(); });
  }

  /** A small drawing of the graph: steps as boxes, edges as lines, scaled to the panel's width. */
  function graphSvg(g) {
    if (!g || !g.nodes.length) return '';
    const W = 150, H = 44;
    const maxX = g.nodes.reduce((m, n) => Math.max(m, n.x + W), 0) + 20;
    const maxY = g.nodes.reduce((m, n) => Math.max(m, n.y + H), 0) + 20;
    const by = {}; g.nodes.forEach((n) => { by[n.id] = n; });
    const lines = g.edges.filter((e) => by[e.from] && by[e.to]).map((e) => {
      const a = by[e.from], b = by[e.to];
      const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2;
      const label = e.case || e.branch || '';
      return '<path d="M' + x1 + ' ' + y1 + ' C' + (x1 + 30) + ' ' + y1 + ' ' + (x2 - 30) + ' ' + y2 + ' ' + x2 + ' ' + y2 + '" fill="none" stroke="var(--meter)" stroke-width="2"></path>'
        + (label ? '<text x="' + ((x1 + x2) / 2) + '" y="' + ((y1 + y2) / 2 - 4) + '" font-size="11" text-anchor="middle" fill="var(--muted)" font-family="inherit">' + esc(label) + '</text>' : '');
    }).join('');
    const boxes = g.nodes.map((n) => '<g><rect x="' + n.x + '" y="' + n.y + '" width="' + W + '" height="' + H + '" rx="6" fill="var(--panel)" stroke="var(--line2)"></rect>'
      + '<text x="' + (n.x + 8) + '" y="' + (n.y + 18) + '" font-size="12" font-weight="600" fill="var(--fg)" font-family="inherit">' + esc(n.title.length > 22 ? n.title.slice(0, 21) + '…' : n.title) + '</text>'
      + '<text x="' + (n.x + 8) + '" y="' + (n.y + 34) + '" font-size="11" fill="var(--muted)" font-family="inherit">' + esc(n.kind) + '</text></g>').join('');
    return '<div class="wftpl-graph"><svg viewBox="0 0 ' + maxX + ' ' + maxY + '" role="img" aria-label="' + esc(g.nodes.length + ' steps: ' + g.nodes.map((n) => n.title).join(', ')) + '">' + lines + boxes + '</svg></div>';
  }

  const needsText = (needs) => {
    const parts = [];
    const add = (k, label) => { if (needs && needs[k] && needs[k].length) parts.push(label + ': ' + needs[k].join(', ')); };
    add('profiles', 'profiles'); add('tools', 'tools'); add('apps', 'apps'); add('decisions', 'decision tables'); add('connections', 'saved queries'); add('knowledge', 'knowledge bases'); add('roles', 'roles'); add('vault', 'vault references');
    return parts;
  };

  App.wfTemplates = function (root, ctx, deps) {
    const t = state(ctx);
    const manage = App.can('workflows:manage');
    if (!t.data && !t.loading && !t.error) load(ctx, deps);
    const items = t.data ? t.data.items : [];
    const words = t.q.toLowerCase().split(/\s+/).filter(Boolean);
    const shown = items.filter((x) => (!t.category || x.category === t.category) && (!t.tag || x.tags.indexOf(t.tag) >= 0) && words.every((w) => (x.title + ' ' + x.summary + ' ' + x.name + ' ' + x.tags.join(' ')).toLowerCase().indexOf(w) >= 0));
    if (t.data && (!t.selId || !shown.some((x) => x.id === t.selId))) { t.selId = shown[0] ? shown[0].id : null; t.detail = null; t.detailError = null; }
    const sel = shown.find((x) => x.id === t.selId);
    if (sel && (!t.detail || t.detail.id !== sel.id) && t.detailLoading !== sel.id && !t.detailError) loadDetail(ctx, deps, sel.id);

    const back = UI.btn('Back to workflows', { size: 'sm', kind: 'ghost', attrs: 'data-wftpl-back' });
    const cats = [{ value: '', label: 'All categories' }].concat((t.data ? t.data.categories : []).map((c) => ({ value: c.name, label: c.name + ' (' + c.count + ')' })));
    const tags = [{ value: '', label: 'All tags' }].concat((t.data ? t.data.tags : []).map((c) => ({ value: c.name, label: c.name + ' (' + c.count + ')' })));
    const toolbar = '<div class="hstack wrap gap6" role="search" aria-label="Filter templates">' + UI.search('Search templates', 'data-wftpl-q', t.q)
      + UI.select(cats, t.category, 'data-wftpl-cat aria-label="Category" style="width:auto"') + UI.select(tags, t.tag, 'data-wftpl-tag aria-label="Tag" style="width:auto"')
      + '<span class="wftpl-sub" aria-live="polite">' + shown.length + ' of ' + items.length + ' template' + (items.length === 1 ? '' : 's') + '</span></div>';
    let body;
    if (t.error) body = UI.problem('Templates could not be loaded', t.error.message, (t.error.problem && t.error.problem.trace_id) || false) + '<div>' + UI.btn('Try again', { size: 'sm', attrs: 'data-wftpl-retry' }) + '</div>';
    else if (!t.data) body = UI.notice('Loading the templates…', 'info');
    else {
      const cards = shown.length ? '<div class="wftpl-grid" role="list" aria-label="Templates">' + shown.map((x) => '<div role="listitem"><button type="button" class="wftpl-card" data-wftpl-sel="' + esc(x.id) + '" aria-pressed="' + (x.id === t.selId ? 'true' : 'false') + '">'
        + '<span class="hstack gap6">' + UI.icon(x.icon || 'workflows', 16) + '<span class="t grow">' + esc(x.title) + '</span></span>'
        + '<span class="s">' + esc(x.summary) + '</span>'
        + '<span class="hstack wrap gap4">' + UI.pill(x.category, 'outline') + (x.builtIn ? UI.pill('built in', '') : UI.pill('this tenant', 'info')) + UI.label(x.label, { sm: true }) + '</span>'
        + '<span class="wftpl-sub">' + x.steps + ' steps · ' + esc(x.trigger) + ' trigger · v' + esc(x.version) + '</span></button></div>').join('') + '</div>'
        : UI.empty('No templates match', 'Clear the search or choose another category or tag.', UI.btn('Clear filters', { size: 'sm', attrs: 'data-wftpl-clear' }));
      let preview = '';
      if (sel) {
        const d = t.detail && t.detail.id === sel.id ? t.detail : null;
        const needs = needsText(sel.needs);
        preview = UI.panel('Preview', '<div class="hstack wrap gap6"><h2 class="serif" style="margin:0;font-size:18px;overflow-wrap:anywhere">' + esc(sel.title) + '</h2>' + UI.label(sel.label, { sm: true }) + '</div>'
          + '<div class="fg2" style="font-size:13px;overflow-wrap:anywhere">' + esc(sel.summary) + '</div>'
          + UI.kv([['Category', esc(sel.category)], ['Version', 'v' + esc(sel.version)], ['Trigger', esc(sel.trigger)], ['Steps', String(sel.steps)], ['Tags', sel.tags.map(esc).join(', ') || 'none'], ['Used', sel.uses + ' time' + (sel.uses === 1 ? '' : 's')]], 2)
          + '<div class="eyebrow">Needs</div>' + (needs.length ? '<ul class="wftpl-sub" style="margin:0 0 0 18px;padding:0">' + needs.map((n) => '<li>' + esc(n) + '</li>').join('') + '</ul>' : '<div class="wftpl-sub">Nothing to bind.</div>')
          + (t.detailError ? UI.problem('The preview could not be loaded', t.detailError.message, false) : d ? graphSvg(d.graph) : UI.notice('Loading the graph…', 'info'))
          + '<div class="hstack wrap gap6">' + (manage ? UI.btn('Use template', { kind: 'primary', size: 'sm', icon: 'plus', attrs: 'data-wftpl-use' }) : '<span class="wftpl-sub">A workflow admin makes workflows from templates.</span>') + (manage && !sel.builtIn ? UI.btn('Delete template', { size: 'sm', kind: 'danger', attrs: 'data-wftpl-del' }) : '') + '</div>', { attrs: 'aria-label="Template preview"' });
      }
      body = cards + preview;
    }
    root.innerHTML = '<style>' + CSS + '</style><div class="page">' + UI.pagehead('Workflow templates', 'Starters for common automations, and the ones your team saved; each makes a draft with its references bound to yours', back) + toolbar + body + '</div>';

    ctx.on('click', '[data-wftpl-back]', () => deps.back());
    ctx.on('click', '[data-wftpl-retry]', () => { t.error = null; ctx.rerender(); });
    ctx.on('click', '[data-wftpl-clear]', () => { t.q = ''; t.category = ''; t.tag = ''; ctx.rerender(); });
    ctx.on('click', '[data-wftpl-sel]', (e, el) => { t.selId = el.dataset.wftplSel; t.detail = null; t.detailError = null; ctx.rerender(); const b = ctx.$('[data-wftpl-sel="' + t.selId + '"]'); if (b) b.focus(); });
    ctx.on('input', '[data-wftpl-q]', (e, el) => { t.q = el.value; clearTimeout(t.qTimer); t.qTimer = setTimeout(() => { ctx.rerender(); const q = ctx.$('[data-wftpl-q]'); if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } }, 250); });
    ctx.on('change', '[data-wftpl-cat]', (e, el) => { t.category = el.value; ctx.rerender(); });
    ctx.on('change', '[data-wftpl-tag]', (e, el) => { t.tag = el.value; ctx.rerender(); });
    ctx.on('click', '[data-wftpl-use]', () => { if (sel) useDialog(ctx, deps, sel); });
    ctx.on('click', '[data-wftpl-del]', async () => {
      if (!sel) return;
      const ok = await ctx.confirm({ title: 'Delete the template', tag: 'delete', tone: 'danger', body: '<p class="fg2" style="margin:0">Workflows already made from ' + esc(sel.title) + ' keep working; nobody can make new ones from it.</p>', ok: 'Delete' });
      if (!ok) return;
      try { await App.del('/api/workflow-templates/' + enc(sel.id)); ctx.toast('<span>' + esc(sel.title) + ' deleted.</span>', 'ok'); t.data = null; t.selId = null; ctx.rerender(); }
      catch (err) { App.fail(err, 'Could not delete the template'); }
    });
  };

  // ---------- use template: name, label and a binding for every reference ----------

  function useDialog(ctx, deps, tpl) {
    const myLabels = LABELS.filter((l) => LABELS.indexOf(l) >= LABELS.indexOf(tpl.label) && (!App.me || LABELS.indexOf(l) <= LABELS.indexOf(App.me.user.clearance)));
    const bindings = { tools: {}, profiles: {}, apps: {}, vault: {}, decisions: {}, roles: {}, connections: {}, knowledge: {} };
    let check = null;
    const rows = () => {
      if (!check) return UI.notice('Checking what the template needs…', 'info');
      const list = check.bindings;
      if (!list.length) return '<div class="wftpl-sub">This template references nothing to bind.</div>';
      return list.map((b, i) => {
        const opts = check.options[OPT[b.kind]] || [];
        const choices = [{ value: b.from, label: 'Keep ' + b.from }].concat(opts.filter((o) => o.value !== b.from));
        const control = b.kind === 'trigger' || b.kind === 'vault' ? '<span class="mono" style="overflow-wrap:anywhere">' + esc(b.to) + '</span>' : UI.select(choices, b.to, 'data-wftpl-bind="' + i + '" aria-label="' + esc(KIND[b.kind] + ' ' + b.from + ' binds to') + '"');
        return '<div class="wftpl-bind"><div><div style="font-size:13px"><b>' + esc(KIND[b.kind] || b.kind) + '</b> <span class="mono">' + esc(b.from) + '</span></div><div class="hstack wrap gap4">' + UI.pill(b.status, b.status === 'bound' ? 'ok' : b.status === 'missing' ? 'danger' : 'info') + '<span class="wftpl-sub">' + esc(b.detail || '') + '</span></div></div><div>' + control + '</div></div>';
      }).join('') + (check.missing ? UI.notice(check.missing + ' reference' + (check.missing === 1 ? ' is' : 's are') + ' missing here. You can still make the draft and bind ' + (check.missing === 1 ? 'it' : 'them') + ' in the designer; publishing checks every reference again.', 'warn') : UI.notice('Every reference resolves here.', 'ok'));
    };
    ctx.modal({
      title: 'Use template: ' + tpl.title, cls: 'wide',
      body: '<div class="formgrid">' + UI.field('Name of the new workflow', UI.input(tpl.name, { attrs: 'data-wftpl-name' }), 'Lower-case letters, digits and hyphens') + UI.field('Label', UI.select(myLabels.length ? myLabels : [tpl.label], tpl.label, 'data-wftpl-label'), 'At least the template\'s ' + tpl.label) + '</div>'
        + '<div class="eyebrow">Bind each reference to one of yours</div><div data-wftpl-rows role="group" aria-label="References">' + rows() + '</div><div data-wftpl-err aria-live="polite"></div>'
        + '<div class="wftpl-sub">The workflow is made in the current workspace as a draft: nothing runs until someone publishes it, and a schedule, event or webhook trigger then runs as that person.</div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Make the draft', { kind: 'primary', attrs: 'data-wftpl-go' }),
      onMount(m) {
        const area = m.querySelector('[data-wftpl-rows]');
        const refresh = () => App.post('/api/workflow-templates/' + enc(tpl.id) + '/check', { bindings }).then((c) => { check = c; area.innerHTML = rows(); }).catch((err) => { area.innerHTML = UI.problem('The references could not be checked', (err.problem && err.problem.detail) || err.message, false); });
        refresh();
        area.addEventListener('change', (e) => {
          const el = e.target.closest('[data-wftpl-bind]'); if (!el || !check) return;
          const b = check.bindings[Number(el.dataset.wftplBind)]; if (!b) return;
          const map = bindings[OPT[b.kind]];
          if (el.value === b.from) delete map[b.from]; else map[b.from] = el.value;
          refresh().then(() => { const again = m.querySelector('[data-wftpl-bind="' + el.dataset.wftplBind + '"]'); if (again) again.focus(); });
        });
        m.querySelector('[data-wftpl-go]').addEventListener('click', async () => {
          const err = m.querySelector('[data-wftpl-err]');
          try {
            const out = await App.post('/api/workflow-templates/' + enc(tpl.id) + '/use', { name: m.querySelector('[data-wftpl-name]').value.trim(), label: m.querySelector('[data-wftpl-label]').value, bindings });
            App.closeOverlay();
            const t = state(ctx); t.data = null;
            ctx.toast('<span>' + esc(out.workflow.name) + ' made from ' + esc(tpl.title) + ' as a draft' + (out.missing ? ', with ' + out.missing + ' reference' + (out.missing === 1 ? '' : 's') + ' to bind' : '') + '.</span>', out.missing ? 'warn' : 'ok', 7000);
            deps.openWorkflow(out.workflow.id);
          } catch (e) { const p = e.problem || {}; err.innerHTML = UI.notice('<b>' + esc(p.title || 'Refused') + '.</b> ' + esc(p.detail || e.message), 'danger'); }
        });
      }
    });
  }

  // ---------- save as template (from the designer) ----------

  App.wfSaveTemplate = function (ctx, wf) {
    ctx.modal({
      title: 'Save as template',
      body: '<div class="wftpl-sub" style="margin-bottom:8px">Saves ' + (wf.publishedVersion ? 'the published version ' + wf.publishedVersion : 'the draft') + ' of ' + esc(wf.name) + ' to the gallery of ' + (wf.workspaceId ? 'this workspace' : 'the tenant') + ', labelled ' + esc(wf.label) + ': only people cleared for it see the template. Runs, versions, webhook secrets and triggers\' owners are not copied.</div>'
        + '<div class="formgrid">' + UI.field('Name', UI.input(wf.name + '-template', { attrs: 'data-wftpl-sname' }), 'Lower-case letters, digits and hyphens') + UI.field('Title', UI.input(wf.name, { attrs: 'data-wftpl-stitle' })) + UI.field('Category', UI.input('General', { attrs: 'data-wftpl-scat' })) + UI.field('Version', UI.input('1.0.0', { attrs: 'data-wftpl-sver' })) + UI.field('Icon', UI.select(ICONS, 'workflows', 'data-wftpl-sicon')) + UI.field('Tags', UI.input('', { placeholder: 'approvals, finance', attrs: 'data-wftpl-stags' }), 'Comma-separated') + '</div>'
        + UI.field('Summary', UI.textarea(wf.description || '', { rows: 2, attrs: 'data-wftpl-ssum' }), 'One or two sentences: what it does and when to use it') + '<div data-wftpl-serr aria-live="polite"></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Save template', { kind: 'primary', attrs: 'data-wftpl-sgo' }),
      onMount(m) {
        const v = (k) => m.querySelector('[data-wftpl-' + k + ']').value.trim();
        m.querySelector('[data-wftpl-sgo]').addEventListener('click', async () => {
          try {
            const out = await App.post('/api/workflow-templates', { workflow: wf.id, name: v('sname'), title: v('stitle'), summary: v('ssum') || v('stitle'), category: v('scat') || 'General', version: v('sver') || '1.0.0', icon: v('sicon'), tags: v('stags').split(',').map((x) => x.trim()).filter(Boolean) });
            App.closeOverlay();
            const st = ctx.state; if (st.tpl) st.tpl.data = null;
            ctx.toast('<span>' + esc(out.title) + ' saved to the template gallery.</span>', 'ok');
          } catch (e) { const p = e.problem || {}; m.querySelector('[data-wftpl-serr]').innerHTML = UI.notice('<b>' + esc(p.title || 'Refused') + '.</b> ' + esc(p.detail || e.message), 'danger'); }
        });
      }
    });
  };
})();
