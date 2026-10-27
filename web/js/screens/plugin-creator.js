(function () {
  // 1.8.0, Sprint 48 (B-147): the plugin creator, opened from Plugins and events (#/plugin-creator). A wizard that
  // writes a plugin manifest in five steps: basics; capabilities from the closed vocabulary; UI surfaces with a live
  // preview drawn by App.surfaces.preview (the console's own renderer); events and what handles them; review. The
  // server builds and checks the manifest on every change (POST /api/admin/plugin-drafts/check) with the same checks
  // as an install. The draft is saved per person; the result is downloaded as an unsigned import bundle or installed
  // as a plugin with nothing granted, to be granted and enabled under Plugins and events. Nothing here is code the
  // server loads.
  const { UI, esc } = App;
  const enc = encodeURIComponent;
  const ID = 'plugin-creator';
  const STEPS = [
    { n: 1, title: 'Basics' },
    { n: 2, title: 'Capabilities' },
    { n: 3, title: 'UI surfaces' },
    { n: 4, title: 'Events and handler' },
    { n: 5, title: 'Review' }
  ];
  const LABELS = ['public', 'internal', 'confidential', 'restricted'];
  const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
  const slugOf = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63).replace(/^[^a-z]+/, '');
  const clone = (x) => JSON.parse(JSON.stringify(x == null ? {} : x));
  const blank = () => ({ basics: { name: '', key: '', description: '', version: '0.1.0', publisher: '' }, capabilities: [], optional: [], surfaces: [], events: [], handler: { type: 'none' } });

  /** Reads and writes a dotted path ("surfaces.0.title") in the wizard. */
  const getAt = (o, path) => path.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
  const setAt = (o, path, v) => { const ks = path.split('.'); let x = o; ks.slice(0, -1).forEach((k, i) => { if (x[k] == null) x[k] = /^\d+$/.test(ks[i + 1]) ? [] : {}; x = x[k]; }); x[ks[ks.length - 1]] = v; };

  /** Placeholder answers for a surface's data calls, shaped by its blocks' paths, for the preview. */
  function sampleFor(surface) {
    const out = {};
    (surface.blocks || []).forEach((b) => {
      if (!b || !b.data) return;
      const v = out[b.data] || (out[b.data] = {});
      if (b.type === 'kv') (b.items || []).forEach((it) => { if (it.path) setAt(v, it.path, 'Sample ' + (it.label || it.path)); });
      if (b.type === 'table' && b.rows) {
        const rows = [1, 2].map((n) => { const r = {}; (b.columns || []).forEach((c) => { if (c.path) setAt(r, c.path, (c.label || c.path) + ' ' + n); }); return r; });
        setAt(v, b.rows, rows);
      }
    });
    return out;
  }

  App.register({
    id: ID, title: 'Plugin creator', section: 'admin', live: true,
    crumb: ['Admin', 'Plugins and events', 'Plugin creator'],
    summary: 'Write a plugin manifest step by step, check it on the server, then download it or install it as a draft',
    commands: [
      { label: 'New plugin draft', sub: 'Plugin creator', run(app) { const s = app.stateFor(ID); s.wantNew = true; app.render(); } }
    ],
    states: [
      { title: 'Manifest refused', tone: 'danger', text: 'A capability outside the vocabulary or a surface calling what it does not declare: the server check lists each problem under its step, and install and download answer 422.',
        apply(ctx) { const st = ctx.state; st.w = st.w || blank(); st.w.capabilities = (st.w.capabilities || []).concat(['read:everything']); st.step = 2; st.check = null; ctx.rerender(); } },
      { title: 'Script plugin needs signing', tone: 'warn', text: 'With PLUGINS_REQUIRE_SIGNED at its default, a script plugin is installed only from a signed import bundle: the review step offers the unsigned bundle to sign, and install answers 409.',
        apply(ctx) { const st = ctx.state; st.w = st.w || blank(); st.w.handler = { type: 'script', language: 'javascript', entry: 'handle' }; st.step = 5; st.check = null; ctx.rerender(); } },
      { title: 'Ready to install', tone: 'ok', text: 'Every step checks out: the review shows the manifest, the downloads and Install as draft, which grants nothing.',
        apply(ctx) { const st = ctx.state; st.step = 5; ctx.rerender(); } }
    ],
    render(root, ctx) {
      const st = ctx.state;
      if (!st.vocab && !st.vocabLoading) {
        st.vocabLoading = true;
        Promise.all([App.get('/api/admin/plugin-drafts/vocabulary'), App.get('/api/admin/plugin-drafts')])
          .then((r) => { st.vocab = r[0]; st.drafts = r[1].drafts || []; })
          .catch((err) => { st.loadError = err; })
          .finally(() => { st.vocabLoading = false; if (App.state.route === ID) ctx.rerender(); });
      }
      if (st.loadError) {
        root.innerHTML = '<div class="page">' + UI.pagehead('Plugin creator', 'Write a plugin manifest step by step') + UI.problem('The plugin creator could not be loaded', st.loadError.message, st.loadError.problem && st.loadError.problem.trace_id) + '<div>' + UI.btn('Try again', { attrs: 'data-retry' }) + '</div></div>';
        ctx.on('click', '[data-retry]', () => { st.loadError = null; ctx.rerender(); });
        return;
      }
      if (!st.vocab) { root.innerHTML = '<div class="page">' + UI.pagehead('Plugin creator', 'Write a plugin manifest step by step') + '<div class="muted" role="status">Loading…</div></div>'; return; }
      if (st.wantNew) { st.wantNew = false; st.draftId = null; st.w = blank(); st.step = 1; st.check = null; st.keyEdited = false; }
      if (ctx.params.draft && st.paramDraft !== ctx.params.draft) { st.paramDraft = ctx.params.draft; const d = (st.drafts || []).find((x) => x.id === ctx.params.draft); if (d) { st.draftId = d.id; st.w = clone(d.wizard); st.step = d.step || 1; st.check = null; } }
      if (!st.w) st.w = blank();
      st.step = st.step || 1;
      const v = st.vocab, w = st.w;
      w.basics = w.basics || {}; w.capabilities = w.capabilities || []; w.optional = w.optional || []; w.surfaces = w.surfaces || []; w.events = w.events || []; w.handler = w.handler || { type: 'none' };
      const capOf = (n) => (v.capabilities || []).find((c) => c.name === n);
      const check = st.check;
      const problemsAt = (n) => (check && check.problems ? check.problems.filter((p) => p.step === n) : []);

      // ---------- the steps ----------
      const stepNav = '<ol class="pc-steps" aria-label="Steps">' + STEPS.map((s) => {
        const n = problemsAt(s.n).length;
        return '<li><button type="button" class="pc-step' + (st.step === s.n ? ' on' : '') + '" data-step="' + s.n + '"' + (st.step === s.n ? ' aria-current="step"' : '') + '><span class="num">' + s.n + '</span><span>' + esc(s.title) + '</span>' + (n ? ' ' + UI.pill(n + ' to fix', 'danger') : '') + '</button></li>';
      }).join('') + '</ol>';

      let body = '';
      if (st.step === 1) {
        const b = w.basics;
        body = UI.panel('Basics', '<div class="pc-two">'
          + UI.field('Name', UI.input(b.name || '', { attrs: 'data-w="basics.name" data-keyfrom maxlength="100"' }), 'What admins see in the plugin list.')
          + UI.field('Key', UI.input(b.key || '', { attrs: 'data-w="basics.key" data-keyedit maxlength="63" spellcheck="false" class="input mono"' }), 'Lowercase letters, digits and hyphens, 2 to 63 characters. It names the plugin for good in this tenant.')
          + '</div>'
          + UI.field('Description', UI.textarea(b.description || '', { rows: 3, attrs: 'data-w="basics.description" maxlength="2000"' }), 'What it does, in a sentence or two.')
          + '<div class="pc-two">' + UI.field('Version', UI.input(b.version || '0.1.0', { attrs: 'data-w="basics.version" maxlength="40" class="input mono"' }), 'A semantic version such as 0.1.0.')
          + UI.field('Publisher', UI.input(b.publisher || '', { attrs: 'data-w="basics.publisher" maxlength="200"' }), 'Optional: who maintains it.') + '</div>');
      } else if (st.step === 2) {
        body = UI.panel('Capabilities', '<p class="fg2" style="margin:0;font-size:13px">A plugin may only ask for capabilities in this closed list; the server refuses a manifest that names anything else. ' + esc(v.optionalHelp) + '</p>'
          + '<div class="vstack gap8">' + (v.capabilities || []).map((c) => {
            const on = w.capabilities.indexOf(c.name) >= 0, opt = w.optional.indexOf(c.name) >= 0;
            return '<div class="pc-cap' + (on ? ' on' : '') + '"><div class="hstack wrap gap6">' + UI.check(c.name, on, 'data-cap="' + esc(c.name) + '"') + UI.pill(c.risk === 'high' ? 'high risk' : 'low risk', c.risk === 'high' ? 'danger' : 'ok')
              + (on ? '<span class="right">' + UI.select([{ value: 'required', label: 'Required' }, { value: 'optional', label: 'Optional' }], opt ? 'optional' : 'required', 'data-capopt="' + esc(c.name) + '" aria-label="' + esc(c.name) + ': required or optional"') + '</span>' : '') + '</div>'
              + '<div class="fg2" style="font-size:13px">' + esc(c.help) + '</div>'
              + (c.events.length || c.calls.length ? '<div class="muted" style="font-size:12px">' + (c.events.length ? 'Events: <span class="mono">' + esc(c.events.join(', ')) + '</span>. ' : '') + (c.calls.length ? 'Calls: <span class="mono">' + esc(c.calls.join(', ')) + '</span>.' : '') + '</div>' : '') + '</div>';
          }).join('') + '</div>' + UI.notice(esc(v.grantsHelp), 'info'));
      } else if (st.step === 3) {
        const sel = Math.min(st.surface || 0, Math.max(0, w.surfaces.length - 1));
        st.surface = sel;
        const s = w.surfaces[sel];
        const slots = (v.slots || []).map((x) => ({ value: x.id, label: x.id }));
        let editor = '';
        if (s) {
          const p = 'surfaces.' + sel;
          const slotHelp = ((v.slots || []).find((x) => x.id === s.slot) || {}).help || '';
          const calls = (kind) => {
            const list = Object.keys(s[kind] || {});
            return '<div class="eyebrow">' + (kind === 'data' ? 'Data calls' : 'Actions') + '</div>' + (list.length ? list.map((id) => {
              const c = s[kind][id] || {};
              return '<div class="pc-row"><div class="pc-three">' + UI.field('Id', UI.input(id, { attrs: 'data-callid="' + kind + '" data-old="' + esc(id) + '" class="input mono" maxlength="40"' }))
                + UI.field('Call', UI.select((v.calls || []).filter((x) => (kind === 'data' ? x.read : true)).map((x) => ({ value: x.api, label: x.api + ' (' + x.capability + ')' })), c.api || '', 'data-w="' + p + '.' + kind + '.' + esc(id) + '.api" data-rr'))
                + '<div class="pc-end">' + UI.btn('Remove', { size: 'sm', kind: 'ghost', attrs: 'data-callrm="' + kind + '" data-id="' + esc(id) + '" aria-label="Remove the call ' + esc(id) + '"' }) + '</div></div>'
                + UI.field('Arguments (JSON)', UI.textarea(JSON.stringify(c.with || {}, null, 1), { rows: 2, attrs: 'data-wjson="' + p + '.' + kind + '.' + esc(id) + '.with" class="textarea mono" spellcheck="false"' }), 'Use "{{context.record}}" and the like for what the slot provides.') + '</div>';
            }).join('') : '<div class="muted" style="font-size:12px">None.</div>') + '<div>' + UI.btn(kind === 'data' ? 'Add a data call' : 'Add an action', { size: 'sm', attrs: 'data-calladd="' + kind + '"' }) + '</div>';
          };
          const blockEditor = (b, i) => {
            const bp = p + '.blocks.' + i;
            let f = '';
            if (b.type === 'text') f = UI.field('Text', UI.textarea(b.text || '', { rows: 2, attrs: 'data-w="' + bp + '.text" maxlength="2000"' }));
            else if (b.type === 'action') f = '<div class="pc-three">' + UI.field('Label', UI.input(b.label || '', { attrs: 'data-w="' + bp + '.label" maxlength="60"' })) + UI.field('Action', UI.select([{ value: '', label: 'Choose' }].concat(Object.keys(s.actions || {}).map((x) => ({ value: x, label: x }))), b.action || '', 'data-w="' + bp + '.action" data-rr')) + UI.field('Confirm', UI.input(b.confirm || '', { attrs: 'data-w="' + bp + '.confirm" maxlength="300"' })) + '</div>';
            else {
              const parts = b.type === 'kv' ? (b.items || []) : (b.columns || []);
              const partKey = b.type === 'kv' ? 'items' : 'columns';
              f = '<div class="pc-three">' + UI.field('Data', UI.select([{ value: '', label: 'Choose' }].concat(Object.keys(s.data || {}).map((x) => ({ value: x, label: x }))), b.data || '', 'data-w="' + bp + '.data" data-rr'))
                + (b.type === 'table' ? UI.field('Rows at', UI.input(b.rows || '', { attrs: 'data-w="' + bp + '.rows" class="input mono" placeholder="records"' })) : '') + '</div>'
                + parts.map((it, j) => '<div class="pc-three">' + UI.field(b.type === 'kv' ? 'Line label' : 'Column', UI.input(it.label || '', { attrs: 'data-w="' + bp + '.' + partKey + '.' + j + '.label" maxlength="80"' })) + UI.field('Path', UI.input(it.path || '', { attrs: 'data-w="' + bp + '.' + partKey + '.' + j + '.path" class="input mono" placeholder="record.values.title"' })) + '<div class="pc-end">' + UI.btn('Remove', { size: 'sm', kind: 'ghost', attrs: 'data-partrm="' + i + '" data-j="' + j + '" aria-label="Remove ' + esc(it.label || 'this line') + '"' }) + '</div></div>').join('')
                + '<div>' + UI.btn(b.type === 'kv' ? 'Add a line' : 'Add a column', { size: 'sm', attrs: 'data-partadd="' + i + '"' }) + '</div>';
            }
            const help = ((v.blocks || []).find((x) => x.type === b.type) || {}).help || '';
            return '<div class="pc-row"><div class="hstack wrap gap6"><b>' + (i + 1) + '. ' + esc(b.type) + '</b><span class="muted grow" style="font-size:12px">' + esc(help) + '</span>'
              + UI.btn('Move up', { size: 'xs', kind: 'ghost', attrs: 'data-blkup="' + i + '"', disabled: i === 0 }) + UI.btn('Move down', { size: 'xs', kind: 'ghost', attrs: 'data-blkdown="' + i + '"', disabled: i === s.blocks.length - 1 }) + UI.btn('Remove', { size: 'xs', kind: 'ghost', attrs: 'data-blkrm="' + i + '" aria-label="Remove block ' + (i + 1) + '"' }) + '</div>' + f + '</div>';
          };
          editor = '<div class="pc-three">' + UI.field('Id', UI.input(s.id || '', { attrs: 'data-w="' + p + '.id" class="input mono" maxlength="40"' })) + UI.field('Title', UI.input(s.title || '', { attrs: 'data-w="' + p + '.title" maxlength="80"' })) + UI.field('Slot', UI.select(slots, s.slot || 'settings', 'data-w="' + p + '.slot" data-rr'), esc(slotHelp)) + '</div>'
            + (s.slot === 'record' ? '<div class="pc-two">' + UI.field('Only beside the app', UI.input(s.app || '', { attrs: 'data-w="' + p + '.app" maxlength="100" placeholder="every app"' })) + UI.field('And entity', UI.input(s.entity || '', { attrs: 'data-w="' + p + '.entity" maxlength="100" placeholder="every entity"' })) + '</div>' : '')
            + UI.field('Description', UI.input(s.description || '', { attrs: 'data-w="' + p + '.description" maxlength="300"' }))
            + '<div class="eyebrow">Capabilities its calls use</div><div class="hstack wrap gap8">' + (w.capabilities.length ? w.capabilities.map((c) => UI.check(c, (s.capabilities || []).indexOf(c) >= 0, 'data-scap="' + esc(c) + '"')).join('') : '<span class="muted" style="font-size:12px">Ask for capabilities in step 2 first.</span>') + '</div>'
            + calls('data') + calls('actions')
            + '<div class="eyebrow">Blocks</div>' + (s.blocks || []).map(blockEditor).join('')
            + '<div class="hstack wrap gap6">' + UI.select((v.blocks || []).map((x) => ({ value: x.type, label: x.type })), 'text', 'data-newblock aria-label="Block type to add"') + UI.btn('Add a block', { size: 'sm', attrs: 'data-blkadd' }) + UI.btn('Remove this surface', { size: 'sm', kind: 'danger', attrs: 'data-surfrm' }) + '</div>';
        }
        body = UI.panel('UI surfaces', '<p class="fg2" style="margin:0;font-size:13px">Panels the console draws from the manifest: text, label and value lines, a table and buttons. No plugin markup or script reaches the browser. Each surface is approved by a tenant admin after install, and its calls run as the person looking at it.</p>'
          + '<div class="hstack wrap gap6">' + w.surfaces.map((x, i) => UI.btn((x.title || x.id || 'Surface ' + (i + 1)), { size: 'sm', kind: i === sel ? 'primary' : '', attrs: 'data-surf="' + i + '"' + (i === sel ? ' aria-pressed="true"' : ' aria-pressed="false"') })).join('') + UI.select(slots, 'settings', 'data-newslot aria-label="Slot of the new surface"') + UI.btn('Add a surface', { size: 'sm', icon: 'plus', attrs: 'data-surfadd', disabled: w.surfaces.length >= 10 }) + '</div>'
          + (s ? editor : UI.empty('No surfaces', 'A plugin may have none: then it only handles events. Add one to give it a panel or an Overview card.')))
          + (s ? UI.panel('Preview', '<div class="muted" style="font-size:12px">Drawn by the console\'s own renderer with sample values in place of the calls\' answers.</div><div data-pcpreview class="vstack gap12"></div>') : '');
      } else if (st.step === 4) {
        const reads = (v.events.groups || []);
        const extra = w.events.filter((e) => !reads.some((g) => g.pattern === e));
        const h = w.handler;
        const acts = h.type === 'actions' ? (h.actions || []) : [];
        let handler = '';
        if (h.type === 'actions') {
          handler = acts.map((a, i) => '<div class="pc-row"><div class="pc-three">' + UI.field('Action', UI.select((v.actions || []).map((x) => ({ value: x.type, label: x.type + ' (' + x.capability + ')' })), a.type, 'data-w="handler.actions.' + i + '.type" data-rr'))
            + UI.field('On', UI.select([{ value: '', label: 'Every event it receives' }].concat(w.events.map((e) => ({ value: e, label: e }))), a.on || '', 'data-w="handler.actions.' + i + '.on" data-rr'))
            + '<div class="pc-end">' + UI.btn('Move up', { size: 'xs', kind: 'ghost', attrs: 'data-actup="' + i + '"', disabled: i === 0 }) + UI.btn('Remove', { size: 'xs', kind: 'ghost', attrs: 'data-actrm="' + i + '" aria-label="Remove action ' + (i + 1) + '"' }) + '</div></div>'
            + UI.field('With (JSON)', UI.textarea(JSON.stringify(a.with || {}, null, 1), { rows: 2, attrs: 'data-wjson="handler.actions.' + i + '.with" class="textarea mono" spellcheck="false"' }), esc(((v.actions || []).find((x) => x.type === a.type) || {}).help || '') + ' Strings may use {{event.type}}, {{event.data.…}} and {{config.…}}.') + '</div>').join('')
            + '<div>' + UI.btn('Add an action', { size: 'sm', attrs: 'data-actadd' }) + '</div>';
        } else if (h.type === 'webhook') handler = UI.field('Address', UI.input(h.url || '', { attrs: 'data-w="handler.url" type="url" placeholder="https://hooks.example.com/exprsn"' }), 'It must be on the tenant\'s allowed hosts; install and enable check it, and every delivery does again.');
        else if (h.type === 'script') handler = '<div class="pc-two">' + UI.field('Language', UI.select([{ value: 'javascript', label: 'JavaScript' }, { value: 'python', label: 'Python' }], h.language || 'javascript', 'data-w="handler.language" data-rr')) + UI.field('Entry function', UI.input(h.entry || 'handle', { attrs: 'data-w="handler.entry" class="input mono" maxlength="200"' })) + '</div>'
          + UI.field('Source', UI.textarea(h.source || '', { rows: 10, attrs: 'data-w="handler.source" class="textarea mono" spellcheck="false" placeholder="Leave empty for the skeleton the creator writes"' }), 'Runs in the script sandbox with no network; it calls the platform through the broker. Left empty, the manifest carries a skeleton that logs each event.')
          + '<div>' + UI.btn('Put the skeleton here to edit', { size: 'sm', attrs: 'data-skeleton' }) + '</div>' + (v.signing && v.signing.policy !== 'none' ? UI.notice('PLUGINS_REQUIRE_SIGNED is ' + esc(v.signing.policy) + ': a script plugin is installed only from a signed import bundle. Download the bundle in the review step and have it signed.', 'warn') : '');
        body = UI.panel('Events', '<p class="fg2" style="margin:0;font-size:13px">What the plugin is told about. Each group needs its read capability.</p><div class="vstack gap6">' + reads.map((g) => {
          const allowed = !g.needs || w.capabilities.indexOf(g.needs) >= 0;
          return '<div>' + UI.check(g.pattern, w.events.indexOf(g.pattern) >= 0, 'data-ev="' + esc(g.pattern) + '"' + (allowed || w.events.indexOf(g.pattern) >= 0 ? '' : ' disabled')) + '<div class="muted" style="font-size:12px;margin-left:24px">' + esc(g.description) + (g.needs ? ' Needs ' + esc(g.needs) + (allowed ? '.' : ', not asked for in step 2.') : '') + '</div></div>';
        }).join('') + '</div>' + UI.field('Other event types', UI.input(extra.join(', '), { attrs: 'data-evextra class="input mono" placeholder="record.updated, flag.created"' }), 'Exact types from the event catalogue, separated by commas.'))
          + UI.panel('Handler', UI.seg((v.handlers || []).map((x) => ({ id: x.type, label: x.type === 'none' ? 'None' : x.type === 'actions' ? 'Declarative actions' : x.type === 'webhook' ? 'Webhook' : 'Script' })), h.type, 'data-handler aria-label="Handler"')
            + '<div class="fg2" style="font-size:13px">' + esc(((v.handlers || []).find((x) => x.type === h.type) || {}).help || '') + '</div>' + handler);
      } else {
        const m = check && check.manifest;
        const caps = w.capabilities;
        const high = caps.filter((c) => (capOf(c) || {}).risk === 'high');
        body = UI.panel('Review', (check ? (check.valid ? UI.notice('<b>Valid.</b> The server checked this manifest with the same rules as an install.', 'ok') : UI.problem('Manifest refused (422)', check.problems.length + ' problem' + (check.problems.length === 1 ? '' : 's') + ' to fix; each step lists its own.', false) + '<ul class="pc-problems">' + check.problems.map((p) => '<li>' + esc(p.message) + ' ' + UI.btn('Step ' + p.step, { size: 'xs', kind: 'ghost', attrs: 'data-step="' + p.step + '"' }) + '</li>').join('') + '</ul>') : '<div class="muted" role="status">Checking…</div>')
          + UI.kv([['Name', esc(w.basics.name || 'not named')], ['Key', '<span class="mono">' + esc(w.basics.key || 'none') + '</span>'], ['Kind', esc(m ? m.kind : '')], ['Capabilities', caps.length ? caps.map((c) => esc(c) + (w.optional.indexOf(c) >= 0 ? ' (optional)' : '')).join(', ') : 'none'], ['High risk', high.length ? '<span style="color:var(--danger-fg)">' + esc(high.join(', ')) + '</span>' : 'none'], ['Events', esc(w.events.join(', ') || 'none')], ['Surfaces', String(w.surfaces.length)], ['Handler', esc(w.handler.type)]], 2)
          + '<div class="eyebrow">What happens next</div><ol class="fg2" style="margin:0;padding-left:20px;font-size:13px"><li>Install as draft adds the plugin in the state installed, with nothing granted. Or download the unsigned bundle, sign manifest.json with your offline key, add manifest.sig as its second entry and import it in Platform.</li><li>Under Plugins and events, grant what it needs. High-risk capabilities are granted only when named.</li><li>Enable it there. Each UI surface is then approved by a tenant admin before anyone sees it.</li></ol>'
          + '<div class="hstack wrap gap6">' + UI.btn('Download bundle', { icon: 'download', attrs: 'data-dl="bundle"', disabled: !(check && check.valid) || !st.draftId }) + UI.btn('Download manifest', { icon: 'download', attrs: 'data-dl="manifest"', disabled: !(check && check.valid) || !st.draftId }) + UI.btn('Install as draft', { kind: 'primary', attrs: 'data-install', disabled: !(check && check.valid) }) + '</div>'
          + (!st.draftId ? '<span class="muted" style="font-size:12px">Save the draft to download it.</span>' : ''));
      }

      const own = problemsAt(st.step);
      const drafts = st.drafts || [];
      const insp = '<div class="eyebrow">Manifest</div><div class="muted" style="font-size:12px" data-pcstate role="status">' + (check ? (check.valid ? 'Checked on the server: valid.' : check.problems.length + ' problem' + (check.problems.length === 1 ? '' : 's') + '.') : 'Checking…') + '</div>'
        + '<div data-pcman class="pc-man">' + (check ? UI.code(JSON.stringify(check.manifest, null, 2), 'json') : '') + '</div>'
        + '<div class="eyebrow">Your drafts</div>' + (drafts.length ? '<div class="vstack gap4">' + drafts.map((d) => '<button type="button" class="listlink' + (d.id === st.draftId ? ' on' : '') + '" data-draft="' + esc(d.id) + '"' + (d.id === st.draftId ? ' aria-current="true"' : '') + '><span class="grow">' + esc(d.name) + '</span><span class="muted" style="font-size:11px">step ' + d.step + ', ' + esc(when(d.updatedAt)) + '</span></button>').join('') + '</div>' : '<div class="muted" style="font-size:12px">None saved yet.</div>')
        + '<span class="muted" style="font-size:12px">Drafts are yours alone. Audit entries: plugin.draft.created, .saved, .exported, .installed, .deleted.</span>';

      root.innerHTML = '<style>#main .pc-steps{list-style:none;margin:0;padding:0;display:flex;flex-wrap:wrap;gap:6px}#main .pc-step{display:flex;align-items:center;gap:6px;border:1px solid var(--line);background:var(--panel);color:var(--fg);border-radius:6px;padding:6px 10px;font:inherit;font-size:13px;cursor:pointer}#main .pc-step.on{border-color:var(--accent);background:var(--accent-tint)}#main .pc-step .num{font-weight:600}#main .pc-two{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:0 12px}#main .pc-three{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:0 10px;align-items:end}#main .pc-end{display:flex;gap:6px;align-items:center;padding-bottom:10px}#main .pc-row{border:1px solid var(--line);border-radius:6px;padding:8px;display:flex;flex-direction:column;gap:6px}#main .pc-cap{border:1px solid var(--line);border-radius:6px;padding:8px;display:flex;flex-direction:column;gap:4px}#main .pc-cap.on{border-color:var(--accent)}#main .pc-man .codebox{max-height:420px;overflow:auto;font-size:11px}#main .pc-problems{margin:0;padding-left:18px;font-size:13px}#main .pc-page > *{flex-shrink:0}</style>'
        + '<div class="page pc-page">' + UI.pagehead('Plugin creator', 'Write a plugin manifest step by step. The server checks it as you go; nothing here is code the server loads.', '<div class="hstack gap6 wrap">' + UI.btn('Plugins and events', { kind: 'ghost', attrs: 'data-goplugins' }) + UI.btn('New draft', { attrs: 'data-new' }) + UI.btn('Save draft', { kind: 'primary', attrs: 'data-save' }) + '</div>')
        + stepNav
        + (own.length ? UI.notice('<b>This step has ' + own.length + ' problem' + (own.length === 1 ? '' : 's') + '.</b> ' + own.map((p) => esc(p.message)).join(' '), 'danger') : '')
        + body
        + '<div class="hstack wrap gap6">' + UI.btn('Back', { attrs: 'data-prev', disabled: st.step === 1 }) + (st.step < 5 ? UI.btn('Next: ' + STEPS[st.step].title, { kind: 'primary', attrs: 'data-next' }) : '') + (st.draftId && st.step === 5 ? '<span class="right">' + UI.btn('Delete draft', { kind: 'danger', attrs: 'data-del' }) + '</span>' : '') + '</div>'
        + '</div><aside class="inspector w360" aria-label="Manifest and drafts">' + insp + '</aside>';

      // ---------- checking on the server ----------
      const paintCheck = () => {
        const c = st.check;
        const state = ctx.$('[data-pcstate]'); if (state) state.textContent = c ? (c.valid ? 'Checked on the server: valid.' : c.problems.length + ' problem' + (c.problems.length === 1 ? '' : 's') + '.') : 'Checking…';
        const man = ctx.$('[data-pcman]'); if (man && c) man.innerHTML = UI.code(JSON.stringify(c.manifest, null, 2), 'json');
      };
      const recheck = (thenRender) => {
        if (st.checkTimer) clearTimeout(st.checkTimer);
        st.checkTimer = setTimeout(() => {
          st.checkTimer = null;
          const seq = (st.checkSeq = (st.checkSeq || 0) + 1);
          App.post('/api/admin/plugin-drafts/check', { wizard: st.w })
            .then((r) => { if (seq !== st.checkSeq) return; const was = JSON.stringify(st.check && st.check.problems); st.check = r; if (App.state.route !== ID) return; if (thenRender || was !== JSON.stringify(r.problems)) { if (!document.getElementById('overlay')) rerenderKeepFocus(); } else paintCheck(); })
            .catch((err) => { if (seq !== st.checkSeq) return; st.check = { valid: false, manifest: {}, problems: [{ step: 1, message: (err.problem && err.problem.detail) || err.message }] }; paintCheck(); });
        }, thenRender ? 0 : 350);
      };
      const rerenderKeepFocus = () => {
        const a = document.activeElement;
        const key = a && a.getAttribute ? (a.getAttribute('data-w') || a.getAttribute('data-wjson')) : null;
        const pos = a && typeof a.selectionStart === 'number' ? a.selectionStart : null;
        ctx.rerender();
        if (key) { const el = ctx.$('[data-w="' + key + '"],[data-wjson="' + key + '"]'); if (el) { el.focus(); if (pos != null && el.setSelectionRange) try { el.setSelectionRange(pos, pos); } catch (e) { /* not a text field */ } } }
      };
      if (!st.check) recheck(true);
      const preview = () => {
        const host = ctx.$('[data-pcpreview]'); const s = w.surfaces[st.surface || 0];
        if (host && s && App.surfaces && App.surfaces.preview) App.surfaces.preview(host, s, sampleFor(s), w.basics.name || w.basics.key || 'This plugin');
      };
      preview();
      const changed = (rerender) => { st.dirty = true; if (rerender) { ctx.rerender(); recheck(false); } else { preview(); recheck(false); } };

      // ---------- saving ----------
      const save = async (quiet) => {
        try {
          const d = st.draftId ? await App.put('/api/admin/plugin-drafts/' + enc(st.draftId), { wizard: st.w, step: st.step }) : await App.post('/api/admin/plugin-drafts', { wizard: st.w });
          if (!st.draftId) { st.draftId = d.id; if (st.step !== 1) await App.put('/api/admin/plugin-drafts/' + enc(d.id), { step: st.step }); }
          st.dirty = false;
          const list = await App.get('/api/admin/plugin-drafts'); st.drafts = list.drafts || [];
          if (!quiet) ctx.toast('Draft saved. Audit event written.', 'ok');
          return true;
        } catch (err) { App.fail(err, 'Draft not saved'); return false; }
      };
      const go = async (n) => { if (n < 1 || n > 5) return; st.step = n; if (st.dirty || st.draftId) await save(true); ctx.rerender(); const h1 = ctx.$('.pc-step.on'); if (h1) h1.focus(); };

      // ---------- handlers ----------
      ctx.on('click', '[data-step]', (e, t) => go(Number(t.dataset.step)));
      ctx.on('click', '[data-next]', () => go(st.step + 1));
      ctx.on('click', '[data-prev]', () => go(st.step - 1));
      ctx.on('click', '[data-save]', () => save(false).then(() => ctx.rerender()));
      ctx.on('click', '[data-goplugins]', () => ctx.navigate('plugins', { tab: 'install' }));
      ctx.on('click', '[data-new]', async () => {
        if (st.dirty && !(await ctx.confirm({ title: 'Start a new draft', tone: 'info', body: '<p class="fg2" style="margin:0">This draft has changes that are not saved. Start a new one anyway?</p>', ok: 'Start new' }))) return;
        st.wantNew = true; ctx.rerender();
      });
      ctx.on('click', '[data-draft]', async (e, t) => {
        const d = (st.drafts || []).find((x) => x.id === t.dataset.draft); if (!d) return;
        if (st.dirty && d.id !== st.draftId && !(await ctx.confirm({ title: 'Open ' + esc(d.name), tone: 'info', body: '<p class="fg2" style="margin:0">This draft has changes that are not saved. Open the other one anyway?</p>', ok: 'Open' }))) return;
        st.draftId = d.id; st.w = clone(d.wizard); st.step = d.step || 1; st.check = null; st.dirty = false; st.surface = 0; st.keyEdited = !!(d.wizard.basics && d.wizard.basics.key); ctx.rerender();
      });
      ctx.on('input', '[data-w]', (e, t) => {
        if (t.tagName === 'SELECT' || t.type === 'checkbox') return;
        setAt(st.w, t.dataset.w, t.value);
        // The key follows the name until it is edited by hand (or a draft was opened with a key of its own).
        if (t.hasAttribute('data-keyedit')) st.keyEdited = true;
        if (t.hasAttribute('data-keyfrom') && !st.keyEdited) { st.w.basics.key = slugOf(t.value); const k = ctx.$('[data-keyedit]'); if (k) k.value = st.w.basics.key; }
        changed(false);
      });
      ctx.on('change', 'select[data-w]', (e, t) => { setAt(st.w, t.dataset.w, t.value); if (t.dataset.w.slice(-3) === '.on' && !t.value) delete getAt(st.w, t.dataset.w.slice(0, -3)).on; changed(t.hasAttribute('data-rr')); });
      ctx.on('input', '[data-wjson]', (e, t) => {
        let val;
        try { val = t.value.trim() ? JSON.parse(t.value) : {}; } catch (err) { t.setAttribute('aria-invalid', 'true'); return; }
        if (!val || typeof val !== 'object' || Array.isArray(val)) { t.setAttribute('aria-invalid', 'true'); return; }
        t.removeAttribute('aria-invalid');
        setAt(st.w, t.dataset.wjson, val); changed(false);
      });
      // capabilities
      ctx.on('change', '[data-cap]', (e, t) => {
        const c = t.dataset.cap;
        w.capabilities = w.capabilities.filter((x) => x !== c); w.optional = w.optional.filter((x) => x !== c);
        if (t.checked) w.capabilities.push(c);
        else w.surfaces.forEach((s) => { s.capabilities = (s.capabilities || []).filter((x) => x !== c); });
        changed(true);
      });
      ctx.on('change', '[data-capopt]', (e, t) => { const c = t.dataset.capopt; w.optional = w.optional.filter((x) => x !== c); if (t.value === 'optional') w.optional.push(c); changed(false); });
      // surfaces
      ctx.on('click', '[data-surf]', (e, t) => { st.surface = Number(t.dataset.surf); ctx.rerender(); });
      ctx.on('click', '[data-surfadd]', () => {
        const slot = (ctx.$('[data-newslot]') || {}).value || 'settings';
        let n = w.surfaces.length + 1; while (w.surfaces.some((s) => s.id === slot + '-' + n)) n++;
        w.surfaces.push({ id: slot + '-' + n, slot: slot, title: 'New ' + slot + ' panel', capabilities: [], data: {}, actions: {}, blocks: [{ type: 'text', text: 'What this panel shows.' }] });
        st.surface = w.surfaces.length - 1; changed(true);
      });
      const surf = () => w.surfaces[st.surface || 0];
      ctx.on('click', '[data-surfrm]', async () => {
        const s = surf(); if (!s) return;
        if (!(await ctx.confirm({ title: 'Remove ' + esc(s.title || s.id), tone: 'danger', body: '<p class="fg2" style="margin:0">The surface and its blocks and calls leave the draft.</p>', ok: 'Remove' }))) return;
        w.surfaces.splice(st.surface || 0, 1); st.surface = 0; changed(true);
      });
      ctx.on('change', '[data-scap]', (e, t) => { const s = surf(); const c = t.dataset.scap; s.capabilities = (s.capabilities || []).filter((x) => x !== c); if (t.checked) s.capabilities.push(c); changed(false); });
      ctx.on('click', '[data-calladd]', (e, t) => {
        const s = surf(); const kind = t.dataset.calladd; s[kind] = s[kind] || {};
        let n = Object.keys(s[kind]).length + 1; while (s[kind][(kind === 'data' ? 'read' : 'act') + n]) n++;
        const api = ((st.vocab.calls || []).find((x) => (kind === 'data' ? x.read : !x.read)) || st.vocab.calls[0]).api;
        s[kind][(kind === 'data' ? 'read' : 'act') + n] = { api: api, with: {} };
        changed(true);
      });
      ctx.on('change', '[data-callid]', (e, t) => {
        const s = surf(); const kind = t.dataset.callid; const old = t.dataset.old; const nu = t.value.trim();
        if (!nu || nu === old || (s[kind] || {})[nu]) { t.value = old; return; }
        const next = {}; Object.keys(s[kind]).forEach((k) => { next[k === old ? nu : k] = s[kind][k]; }); s[kind] = next;
        (s.blocks || []).forEach((b) => { if (kind === 'data' && b.data === old) b.data = nu; if (kind === 'actions' && b.action === old) b.action = nu; });
        changed(true);
      });
      ctx.on('click', '[data-callrm]', (e, t) => { const s = surf(); delete (s[t.dataset.callrm] || {})[t.dataset.id]; changed(true); });
      ctx.on('click', '[data-blkadd]', () => {
        const s = surf(); const type = (ctx.$('[data-newblock]') || {}).value || 'text'; s.blocks = s.blocks || [];
        const firstData = Object.keys(s.data || {})[0] || ''; const firstAct = Object.keys(s.actions || {})[0] || '';
        s.blocks.push(type === 'text' ? { type: 'text', text: '' } : type === 'kv' ? { type: 'kv', data: firstData, items: [{ label: 'Title', path: 'record.values.title' }] } : type === 'table' ? { type: 'table', data: firstData, rows: 'records', columns: [{ label: 'Title', path: 'values.title' }] } : { type: 'action', label: 'Run', action: firstAct });
        changed(true);
      });
      const moveBlock = (i, d) => { const s = surf(); const j = i + d; if (j < 0 || j >= s.blocks.length) return; const x = s.blocks[i]; s.blocks[i] = s.blocks[j]; s.blocks[j] = x; changed(true); const b = ctx.$('[data-' + (d < 0 ? 'blkup' : 'blkdown') + '="' + j + '"]'); if (b && !b.disabled) b.focus(); };
      ctx.on('click', '[data-blkup]', (e, t) => moveBlock(Number(t.dataset.blkup), -1));
      ctx.on('click', '[data-blkdown]', (e, t) => moveBlock(Number(t.dataset.blkdown), 1));
      ctx.on('click', '[data-blkrm]', (e, t) => { surf().blocks.splice(Number(t.dataset.blkrm), 1); changed(true); });
      ctx.on('click', '[data-partadd]', (e, t) => { const b = surf().blocks[Number(t.dataset.partadd)]; const k = b.type === 'kv' ? 'items' : 'columns'; b[k] = b[k] || []; b[k].push({ label: '', path: '' }); changed(true); });
      ctx.on('click', '[data-partrm]', (e, t) => { const b = surf().blocks[Number(t.dataset.partrm)]; const k = b.type === 'kv' ? 'items' : 'columns'; b[k].splice(Number(t.dataset.j), 1); changed(true); });
      // events and handler
      ctx.on('change', '[data-ev]', (e, t) => { const p = t.dataset.ev; w.events = w.events.filter((x) => x !== p); if (t.checked) w.events.push(p); changed(true); });
      ctx.on('change', '[data-evextra]', (e, t) => { const groups = (st.vocab.events.groups || []).map((g) => g.pattern); w.events = w.events.filter((x) => groups.indexOf(x) >= 0).concat(t.value.split(',').map((x) => x.trim()).filter(Boolean)); changed(true); });
      ctx.on('click', '[data-handler] [data-seg]', (e, t) => {
        const type = t.dataset.seg; if (type === w.handler.type) return;
        w.handler = type === 'actions' ? { type: 'actions', actions: [{ type: 'log', with: { message: 'Received {{event.type}}' } }] } : type === 'webhook' ? { type: 'webhook', url: '' } : type === 'script' ? { type: 'script', language: 'javascript', entry: 'handle' } : { type: 'none' };
        changed(true);
      });
      ctx.on('click', '[data-actadd]', () => { w.handler.actions = w.handler.actions || []; w.handler.actions.push({ type: 'log', with: {} }); changed(true); });
      ctx.on('click', '[data-actrm]', (e, t) => { w.handler.actions.splice(Number(t.dataset.actrm), 1); changed(true); });
      ctx.on('click', '[data-actup]', (e, t) => { const i = Number(t.dataset.actup); const a = w.handler.actions; if (i < 1) return; const x = a[i]; a[i] = a[i - 1]; a[i - 1] = x; changed(true); });
      ctx.on('click', '[data-skeleton]', () => { const m = st.check && st.check.manifest; if (m && m.script && m.script.source) { w.handler.source = m.script.source; changed(true); } else ctx.toast('The skeleton appears once the server has checked the draft.', '', 2500); });
      // review
      ctx.on('click', '[data-dl]', async (e, t) => {
        if (st.dirty && !(await save(true))) return;
        const a = document.createElement('a'); a.href = '/api/admin/plugin-drafts/' + enc(st.draftId) + '/download?format=' + enc(t.dataset.dl); a.download = ''; document.body.appendChild(a); a.click(); a.remove();
        ctx.toast(t.dataset.dl === 'bundle' ? 'Unsigned bundle downloaded. Sign manifest.json offline, add manifest.sig second, then import it in Platform. Audited plugin.draft.exported.' : 'Manifest downloaded. Audited plugin.draft.exported.', 'ok', 6000);
      });
      ctx.on('click', '[data-install]', () => {
        let label = 'internal';
        ctx.modal({ title: 'Install ' + esc(w.basics.name || w.basics.key) + ' as a draft',
          body: '<p class="fg2" style="margin:0">The plugin is added in the state installed with no capability granted. Nothing runs until an admin grants what it needs and enables it under Plugins and events; its UI surfaces are approved one by one after that.</p>'
            + UI.field('Highest label it may receive', UI.select(LABELS.filter((l) => App.me && App.me.user && App.me.user.clearance ? LABELS.indexOf(l) <= LABELS.indexOf(App.me.user.clearance) : true).map((l) => ({ value: l, label: l })), label, 'data-maxlabel'), 'Events and data above it never reach the plugin.') + '<div data-err role="alert"></div>',
          actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Install as draft', { kind: 'primary', attrs: 'data-go' }),
          onMount(m) {
            m.querySelector('[data-maxlabel]').addEventListener('change', (ev) => { label = ev.target.value; });
            m.querySelector('[data-go]').addEventListener('click', async () => {
              if ((st.dirty || !st.draftId) && !(await save(true))) return;
              try {
                const p = await App.post('/api/admin/plugin-drafts/' + enc(st.draftId) + '/install', { maxLabel: label });
                App.closeOverlay();
                ctx.toast(esc(p.name) + ' installed, nothing granted. Grant and enable it under Plugins and events. Audited plugin.draft.installed.', 'ok', 6000);
                ctx.navigate('plugins', { id: p.id });
              } catch (err) { const pr = err.problem || {}; m.querySelector('[data-err]').innerHTML = UI.notice('<b>' + esc(pr.title || 'Not installed') + '.</b> ' + esc(err.message), 'danger'); }
            });
          } });
      });
      ctx.on('click', '[data-del]', async () => {
        if (!(await ctx.confirm({ title: 'Delete this draft', tone: 'danger', body: '<p class="fg2" style="margin:0">The draft is deleted. A plugin installed from it stays installed.</p>', ok: 'Delete' }))) return;
        try { await App.del('/api/admin/plugin-drafts/' + enc(st.draftId)); const list = await App.get('/api/admin/plugin-drafts'); st.drafts = list.drafts || []; st.wantNew = true; ctx.toast('Draft deleted. Audit event written.', 'ok'); ctx.rerender(); } catch (err) { App.fail(err, 'Not deleted'); }
      });
    }
  });
})();
