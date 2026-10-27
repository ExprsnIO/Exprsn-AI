// User stores › the store wizard, the form editor, archive and restore, and backups (1.9.0, Sprint 54: B-181, B-185,
// B-186). The User stores screen (directories.js) calls in through App.storeWizard, App.storeEditor, App.storeArchived,
// App.storeInspectorExtras, App.storeHandlers and App.storeBackupsTab.
//
// Everything here is driven by the kind registry the server sends (GET /api/admin/identity-store-kinds): each kind's
// form sections and fields are generated from its zod schema, so a new kind needs no change on this side. Secrets are
// references (vault:path#key, env:NAME, file:/path); the wizard's test password is read from its field when the test
// runs, sent once, and never kept.
(function () {
  const { UI, esc } = App;
  const enc = encodeURIComponent;
  const CSS = '<style>.overlay .stw-steps{display:flex;flex-wrap:wrap;gap:4px;margin:0;padding:0;list-style:none}.overlay .stw-steps li{font-size:12px;padding:2px 8px;border-radius:10px;border:1px solid var(--line);color:var(--fg2)}.overlay .stw-steps li[aria-current="step"]{border-color:var(--accent);color:var(--fg);font-weight:600}.overlay .stw-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}.overlay .stw-kinds{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px}.overlay .stw-kind{display:block;text-align:left;border:1px solid var(--line);border-radius:6px;padding:8px 10px;background:var(--panel);color:var(--fg);cursor:pointer;min-width:0}.overlay .stw-kind[aria-pressed="true"]{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}.overlay .stw-kind span{display:block;font-size:12px;color:var(--fg2);overflow-wrap:anywhere}.overlay .stw-err{color:var(--danger-fg);font-size:12px}.overlay .stw-order{display:flex;flex-direction:column;gap:4px}.overlay .stw-order li{display:flex;align-items:center;gap:6px;border:1px solid var(--line);border-radius:6px;padding:4px 8px;min-width:0}.overlay .stw-order li b{flex:1;min-width:0;overflow-wrap:anywhere}.overlay .stw-wrap{overflow-wrap:anywhere;min-width:0}.overlay .stw-map{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr) minmax(0,1fr) auto;gap:6px;align-items:end}@media (max-width:640px){.overlay .stw-map{grid-template-columns:minmax(0,1fr)}}</style>';
  const STEPS = [['kind', 'Kind or preset'], ['connection', 'Connection'], ['attributes', 'Attributes and groups'], ['order', 'Sign-in order'], ['test', 'Test'], ['review', 'Review']];
  const LABELS = ['public', 'internal', 'confidential', 'restricted'];
  const detailOf = (err) => (err && err.problem && (err.problem.detail || err.problem.title)) || (err && err.message) || 'Something went wrong.';
  const when = (ms) => (ms ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
  const stepsHtml = (steps) => UI.timeline((steps || []).map((s) => ({ title: esc(String(s.title).trim()), text: s.detail ? esc(s.detail) : '', meta: s.ms != null ? s.ms + ' ms' : '', tone: s.ok ? 'ok' : 'danger' })));
  const clone = (v) => JSON.parse(JSON.stringify(v || {}));

  let kindsCache = null;
  const loadKinds = () => (kindsCache ? Promise.resolve(kindsCache) : App.get('/api/admin/identity-store-kinds').then((r) => { kindsCache = r; return r; }));
  App.storeKindsReset = () => { kindsCache = null; };

  // ---------- dotted paths into a configuration ----------
  const getPath = (obj, key) => key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
  function setPath(obj, key, value) {
    const parts = key.split('.'); let o = obj;
    for (let i = 0; i < parts.length - 1; i++) { if (!o[parts[i]] || typeof o[parts[i]] !== 'object') o[parts[i]] = {}; o = o[parts[i]]; }
    const last = parts[parts.length - 1];
    if (value === undefined) delete o[last]; else o[last] = value;
    // Drop an emptied nested object, so an optional block (groupTable) is not sent half filled.
    if (parts.length > 1 && !Object.keys(o).length) setPath(obj, parts.slice(0, -1).join('.'), undefined);
  }

  // ---------- one generated field ----------
  function fieldHtml(f, config, errors) {
    const v = getPath(config, f.key);
    const id = 'stw-' + f.key.replace(/[^A-Za-z0-9]/g, '-');
    const err = (errors || []).filter((e) => e.path === 'config.' + f.key || e.path.indexOf('config.' + f.key + '.') === 0).map((e) => e.message);
    const hint = (f.help ? esc(f.help) : '') + (f.default !== undefined && f.type !== 'boolean' ? (f.help ? ' ' : '') + 'Default: <span class="mono">' + esc(Array.isArray(f.default) ? f.default.join(', ') || 'none' : String(f.default)) + '</span>.' : '') + (err.length ? '<div class="stw-err" role="alert">' + err.map(esc).join(' ') + '</div>' : '');
    const label = f.label + (f.required ? ' (required)' : '');
    const data = 'data-cf="' + esc(f.key) + '" data-ct="' + esc(f.type) + '" id="' + id + '"' + (err.length ? ' aria-invalid="true"' : '');
    const hid = id + '-hint';
    if (f.type === 'boolean') return '<div class="field">' + UI.check(f.label, v === undefined ? !!f.default : !!v, data + (hint ? ' aria-describedby="' + hid + '"' : '')) + (hint ? '<div class="hint" id="' + hid + '">' + hint + '</div>' : '') + '</div>';
    if (f.type === 'select') return UI.field(label, UI.select((f.required || f.default !== undefined ? [] : [{ value: '', label: 'Not set' }]).concat(f.options.map((o) => ({ value: o, label: o }))), v === undefined ? (f.default !== undefined ? String(f.default) : '') : String(v), data), hint || null);
    if (f.type === 'multiselect') {
      const on = Array.isArray(v) ? v : Array.isArray(f.default) ? f.default : [];
      return '<div class="field" role="group" aria-labelledby="' + id + '-label"' + (hint ? ' aria-describedby="' + hid + '"' : '') + '><span class="fl" id="' + id + '-label">' + esc(label) + '</span><div class="hstack wrap" style="gap:12px 18px" ' + data + '>' + f.options.map((o) => UI.check(o, on.indexOf(o) >= 0, 'data-cm="' + esc(o) + '"')).join('') + '</div>' + (hint ? '<div class="hint" id="' + hid + '">' + hint + '</div>' : '') + '</div>';
    }
    if (f.type === 'list') return UI.field(label, UI.textarea(Array.isArray(v) ? v.join('\n') : '', { attrs: data + ' spellcheck="false"', rows: 3, placeholder: 'One per line' }), hint || null);
    if (f.multiline) return UI.field(label, UI.textarea(v === undefined || v === null ? '' : String(v), { attrs: data + ' spellcheck="false" style="font-family:var(--mono);font-size:12px"', rows: 6, placeholder: f.placeholder || '' }), hint || null);
    const type = f.type === 'number' ? 'number' : f.type === 'url' ? 'url' : 'text';
    return UI.field(label, UI.input(v === undefined || v === null ? '' : String(v), { type, attrs: data + ' autocomplete="off" spellcheck="false"' + (f.min != null && f.type === 'number' ? ' min="' + f.min + '"' : '') + (f.max != null && f.type === 'number' ? ' max="' + f.max + '"' : ''), placeholder: f.placeholder || '' }), hint || null);
  }

  /** The sections of one wizard step (or all of them) as a form. */
  function formHtml(kind, step, config, errors) {
    const secs = kind.sections.filter((s) => !step || s.step === step);
    if (!secs.length) return UI.notice('Nothing to set in this step for ' + esc(kind.title) + '.', 'info');
    return secs.map((s) => {
      const basic = s.fields.filter((f) => !f.advanced); const adv = s.fields.filter((f) => f.advanced);
      return '<fieldset style="border:1px solid var(--line);border-radius:6px;padding:8px 10px;margin:0;min-width:0"><legend class="eyebrow" style="padding:0 4px">' + esc(s.title) + '</legend>' + (s.description ? '<div class="fg2" style="font-size:12px;margin-bottom:6px">' + esc(s.description) + '</div>' : '')
        + '<div class="stw-grid">' + basic.map((f) => fieldHtml(f, config, errors)).join('') + '</div>'
        + (adv.length ? '<details style="margin-top:6px"><summary style="cursor:pointer;font-size:12px">Advanced</summary><div class="stw-grid" style="margin-top:6px">' + adv.map((f) => fieldHtml(f, config, errors)).join('') + '</div></details>' : '') + '</fieldset>';
    }).join('');
  }

  /** Reads the generated fields under `root` into `config`. */
  function readForm(root, config) {
    root.querySelectorAll('[data-cf]').forEach((el) => {
      const key = el.dataset.cf; const type = el.dataset.ct;
      if (type === 'boolean') { setPath(config, key, el.checked); return; }
      if (type === 'multiselect') { setPath(config, key, Array.prototype.slice.call(el.querySelectorAll('[data-cm]:checked')).map((c) => c.dataset.cm)); return; }
      const raw = el.value;
      if (type === 'list') { const list = raw.split('\n').map((x) => x.trim()).filter(Boolean); setPath(config, key, list.length ? list : undefined); return; }
      if (raw.trim() === '') { setPath(config, key, undefined); return; }
      setPath(config, key, type === 'number' ? Number(raw) : raw.trim());
    });
    return config;
  }

  // ---------- the wizard (B-181) ----------
  App.storeWizard = function (ctx, opts) {
    opts = opts || {};
    loadKinds().then((reg) => open(reg)).catch((err) => App.fail(err, 'The store kinds could not be loaded'));
    function open(reg) {
      const stores = (opts.providers || []).filter((p) => p.state !== 'archived');
      // The order route names every store once; archived ones (kept until purged) go last, after the chain.
      const archivedIds = (opts.providers || []).filter((p) => p.state === 'archived').map((p) => p.id);
      const w = { step: 0, kind: null, preset: null, name: '', config: {}, errors: [], mappings: [], order: stores.map((p) => p.id).concat(['new']), test: null, enable: true, reason: '', busy: false, json: false };
      const roles = opts.roles || [];
      const pick = (k, preset) => {
        w.kind = reg.kinds.find((x) => x.kind === k) || null; w.preset = preset || null;
        w.config = preset ? clone(preset.config) : {}; w.mappings = preset && preset.mappings ? clone(preset.mappings) : []; w.errors = []; w.test = null;
      };
      if (opts.kind) { const [k, p] = String(opts.kind).split(':'); pick(k, null); if (w.kind && p) { const pr = (w.kind.presets || []).find((x) => x.id === p); if (pr) pick(k, pr); } }
      const nameOf = (id) => (id === 'new' ? (w.name || 'The new store') + ' (new)' : ((stores.find((p) => p.id === id) || {}).name || id));
      ctx.modal({ cls: 'wide', title: 'Add user store', body: CSS + '<div data-wz class="vstack gap12"></div>', onMount(m) {
        const root = m.querySelector('[data-wz]');
        const render = () => {
          const cur = STEPS[w.step][0];
          let body = '<ol class="stw-steps" aria-label="Steps">' + STEPS.map((s, i) => '<li' + (i === w.step ? ' aria-current="step"' : '') + '>' + (i + 1) + '. ' + esc(s[1]) + '</li>').join('') + '</ol><h3 style="margin:0">' + esc(STEPS[w.step][1]) + '</h3>';
          if (cur === 'kind') {
            body += UI.field('Name', UI.input(w.name, { attrs: 'data-wname maxlength="100"', placeholder: 'for example Corporate OpenLDAP' }))
              + '<div class="stw-kinds" role="group" aria-label="Kind or preset">' + reg.kinds.map((k) => '<button type="button" class="stw-kind" data-wkind="' + esc(k.kind) + '" aria-pressed="' + (w.kind && w.kind.kind === k.kind && !w.preset ? 'true' : 'false') + '"><b>' + esc(k.title) + '</b><span>' + esc(k.description || '') + '</span></button>'
                + (k.presets || []).map((p) => '<button type="button" class="stw-kind" data-wkind="' + esc(k.kind) + '" data-wpreset="' + esc(p.id) + '" aria-pressed="' + (w.preset && w.preset.id === p.id && w.kind.kind === k.kind ? 'true' : 'false') + '"><b>' + esc(p.title) + '</b><span>Preset of ' + esc(k.title) + (p.description ? ': ' + esc(p.description) : '') + '</span></button>').join('')).join('') + '</div>';
          } else if (cur === 'connection' || cur === 'attributes') {
            body += UI.seg([{ id: 'form', label: 'Form' }, { id: 'json', label: 'JSON (advanced)' }], w.json ? 'json' : 'form', 'aria-label="Editor"')
              + (w.json ? UI.field('Configuration (JSON)', UI.textarea(JSON.stringify(w.config, null, 2), { attrs: 'data-wjson spellcheck="false" style="font-family:var(--mono);font-size:12px"', rows: 14 }), 'Secrets as references only: <span class="mono">vault:path#key</span>, <span class="mono">env:NAME</span> or <span class="mono">file:/path</span>.') : formHtml(w.kind, cur, w.config, w.errors));
            if (cur === 'attributes') {
              body += '<fieldset style="border:1px solid var(--line);border-radius:6px;padding:8px 10px;margin:0;min-width:0"><legend class="eyebrow" style="padding:0 4px">Group mappings</legend><div class="fg2" style="font-size:12px;margin-bottom:6px">A group as this store names it, mapped to a role and clearance. Added when the store is saved; more under Group mappings.</div>'
                + w.mappings.map((mp, i) => '<div class="stw-map" data-wmap="' + i + '">' + UI.field('Group', UI.input(mp.group, { attrs: 'data-wmg maxlength="512"' })) + UI.field('Role', UI.select(roles.map((r) => ({ value: r.id, label: r.name })), mp.role, 'data-wmr')) + UI.field('Clearance', UI.select(LABELS, mp.clearance, 'data-wmc')) + UI.btn('Remove', { size: 'sm', kind: 'ghost', attrs: 'data-wmx="' + i + '"' }) + '</div>').join('')
                + '<div>' + UI.btn('Add a mapping', { size: 'sm', icon: 'plus', attrs: 'data-wmadd' }) + '</div></fieldset>';
            }
          } else if (cur === 'order') {
            body += '<div class="fg2" style="font-size:12px">Stores are asked in this order. A store that does not know the username passes to the next; a wrong password in the store that owns it stops there.</div><ol class="stw-order" style="margin:0;padding:0;list-style:none">'
              + w.order.map((id, i) => '<li><span class="num">' + (i + 1) + '</span><b>' + esc(nameOf(id)) + '</b>' + UI.iconbtn('chevd', 'Move ' + nameOf(id) + ' earlier', { attrs: 'data-wup="' + i + '" style="transform:rotate(180deg)"' + (i === 0 ? ' disabled' : ''), cls: 'sm ghost' }) + UI.iconbtn('chevd', 'Move ' + nameOf(id) + ' later', { attrs: 'data-wdown="' + i + '"' + (i === w.order.length - 1 ? ' disabled' : ''), cls: 'sm ghost' }) + '</li>').join('') + '</ol>';
          } else if (cur === 'test') {
            const redirect = w.kind.signIn !== 'password';
            body += UI.notice(redirect ? esc(w.kind.title) + ' signs in by redirect or is pushed to: the test checks that it can be reached. Sign in through it once it is saved.' : 'Sign in as a real account of this store, or give a username only to look it up. The password is sent once for this test and is never stored or logged; only the username is audited.', 'info')
              + (redirect ? '' : '<div class="stw-grid">' + UI.field('Username', UI.input(w.test && w.test.username || '', { attrs: 'data-wtu autocomplete="off" maxlength="190"' })) + UI.field('Password (optional)', UI.input('', { type: 'password', attrs: 'data-wtp autocomplete="new-password"' })) + '</div>')
              + '<div>' + UI.btn(w.busy ? 'Testing…' : 'Run test', { kind: 'primary', size: 'sm', icon: 'play', attrs: 'data-wtest' + (w.busy ? ' disabled' : '') }) + '</div>'
              + (w.test && w.test.result ? '<div role="status">' + UI.notice('Result: <b>' + esc(w.test.result.result.replace('_', ' ')) + '</b>' + (w.test.result.user ? ' as <span class="mono">' + esc(w.test.result.user.username) + '</span>, groups ' + (w.test.result.user.groups.length ? w.test.result.user.groups.map((g) => '<span class="mono">' + esc(g) + '</span>').join(', ') : 'none') : ''), w.test.result.ok ? 'ok' : 'danger') + '</div>' + UI.panel('Steps', stepsHtml(w.test.result.steps)) : '');
          } else {
            const pos = w.order.indexOf('new');
            body += UI.kv([['Name', esc(w.name)], ['Kind', esc(w.kind.title) + (w.preset ? ' (preset ' + esc(w.preset.title) + ')' : '')], ['Sign-in order', String(pos + 1) + ' of ' + w.order.length], ['Group mappings', String(w.mappings.filter((x) => x.group.trim()).length)], ['Test', w.test && w.test.result ? esc(w.test.result.result.replace('_', ' ')) + (w.test.username ? ' (' + esc(w.test.username) + ')' : '') : 'not run']], 2)
              + '<div class="eyebrow">Configuration</div>' + UI.code(JSON.stringify(w.config, null, 2), 'json')
              + UI.check('Enable the store now', w.enable, 'data-wenable')
              + (w.test && w.test.result && w.test.result.ok && w.test.username ? UI.notice('Saving tests again with <span class="mono">' + esc(w.test.username) + '</span> (looked up, no password) and refuses to save if the store cannot find the account.', 'info') : '')
              + UI.field('Reason (kept with the version)', UI.input(w.reason, { attrs: 'data-wreason maxlength="500"', placeholder: 'for example Finance moves to the HR directory' }));
          }
          body += '<div data-werr></div><div class="hstack wrap gap6" style="justify-content:flex-end">' + UI.btn('Cancel', { attrs: 'data-close' }) + (w.step > 0 ? UI.btn('Back', { attrs: 'data-wback' }) : '') + (w.step < STEPS.length - 1 ? UI.btn('Next', { kind: 'primary', attrs: 'data-wnext' + (w.kind ? '' : ' disabled') }) : UI.btn(w.busy ? 'Saving…' : 'Save store', { kind: 'primary', attrs: 'data-wsave' + (w.busy ? ' disabled' : '') })) + '</div>';
          root.innerHTML = body;
          const h = root.querySelector('h3'); if (h) { h.tabIndex = -1; }
        };
        const errBox = (html) => { const b = root.querySelector('[data-werr]'); if (b) b.innerHTML = html; };
        const problemHtml = (err) => { const p = err.problem || {}; return UI.notice('<b>' + esc(detailOf(err)) + '</b>' + (p.errors ? '<ul style="margin:4px 0 0;padding-left:18px">' + p.errors.map((x) => '<li><span class="mono">' + esc(x.path) + '</span>: ' + esc(x.message) + '</li>').join('') + '</ul>' : ''), 'danger'); };
        // Takes in what is on screen before a step changes.
        const capture = () => {
          const cur = STEPS[w.step][0];
          if (cur === 'kind') { const n = root.querySelector('[data-wname]'); if (n) w.name = n.value.trim(); }
          if (cur === 'connection' || cur === 'attributes') {
            const j = root.querySelector('[data-wjson]');
            if (j) { try { w.config = JSON.parse(j.value || '{}'); } catch (e) { errBox(UI.notice('The configuration is not valid JSON: ' + esc(e.message), 'danger')); return false; } } else readForm(root, w.config);
            root.querySelectorAll('[data-wmap]').forEach((row) => { const i = Number(row.dataset.wmap); w.mappings[i] = { group: row.querySelector('[data-wmg]').value, role: row.querySelector('[data-wmr]').value, clearance: row.querySelector('[data-wmc]').value }; });
          }
          if (cur === 'test') { const u = root.querySelector('[data-wtu]'); if (u) w.test = Object.assign(w.test || {}, { username: u.value.trim() }); }
          if (cur === 'review') { w.enable = root.querySelector('[data-wenable]').checked; w.reason = root.querySelector('[data-wreason]').value.trim(); }
          return true;
        };
        const go = async (delta) => {
          if (!capture()) return;
          const cur = STEPS[w.step][0];
          if (delta > 0 && cur === 'kind' && !w.name) { errBox(UI.notice('Give the store a name.', 'warn')); return; }
          if (delta > 0 && (cur === 'connection' || cur === 'attributes')) {
            try {
              const r = await App.post('/api/admin/identity-store-kinds/' + enc(w.kind.kind) + '/check', { step: cur, config: w.config });
              w.errors = r.errors; if (!r.ok) { render(); errBox(UI.notice('<b>Some settings need attention.</b><ul style="margin:4px 0 0;padding-left:18px">' + r.errors.map((x) => '<li><span class="mono">' + esc(x.path) + '</span>: ' + esc(x.message) + '</li>').join('') + '</ul>', 'danger')); return; }
            } catch (err) { errBox(problemHtml(err)); return; }
          }
          if (delta > 0 && cur === 'test' && !(w.test && w.test.result)) { /* the test is recommended, not required */ }
          w.step = Math.max(0, Math.min(STEPS.length - 1, w.step + delta)); render();
          const h = root.querySelector('h3'); if (h) h.focus();
        };
        root.addEventListener('click', async (e) => {
          const t = e.target.closest('button'); if (!t) return;
          if (t.dataset.wkind) { capture(); const k = reg.kinds.find((x) => x.kind === t.dataset.wkind); pick(t.dataset.wkind, t.dataset.wpreset ? (k.presets || []).find((p) => p.id === t.dataset.wpreset) : null); render(); const b = root.querySelector('[data-wkind="' + t.dataset.wkind + '"]' + (t.dataset.wpreset ? '[data-wpreset="' + t.dataset.wpreset + '"]' : ':not([data-wpreset])')); if (b) b.focus(); return; }
          if (t.dataset.seg) { if (!capture()) return; w.json = t.dataset.seg === 'json'; render(); return; }
          if (t.hasAttribute('data-wnext')) return go(1);
          if (t.hasAttribute('data-wback')) return go(-1);
          if (t.hasAttribute('data-wmadd')) { capture(); w.mappings.push({ group: '', role: 'member', clearance: 'internal' }); render(); return; }
          if (t.dataset.wmx) { capture(); w.mappings.splice(Number(t.dataset.wmx), 1); render(); return; }
          if (t.dataset.wup || t.dataset.wdown) { const i = Number(t.dataset.wup || t.dataset.wdown); const j = t.dataset.wup ? i - 1 : i + 1; const x = w.order[i]; w.order[i] = w.order[j]; w.order[j] = x; render(); const b = root.querySelector(t.dataset.wup ? '[data-wup="' + j + '"]' : '[data-wdown="' + j + '"]'); if (b && !b.disabled) b.focus(); return; }
          if (t.hasAttribute('data-wtest')) {
            const u = root.querySelector('[data-wtu]'); const pw = root.querySelector('[data-wtp]');
            const username = u ? u.value.trim() : ''; const password = pw ? pw.value : '';
            if (pw) pw.value = ''; // never kept on screen or in memory after the call
            w.busy = true; render();
            try {
              const r = await App.post('/api/admin/identity-store-kinds/' + enc(w.kind.kind) + '/test', Object.assign({ config: w.config }, username ? { credentials: password ? { username, password } : { username } } : {}));
              w.test = { username, result: r };
            } catch (err) { w.test = { username, result: null }; w.busy = false; render(); errBox(problemHtml(err)); return; }
            w.busy = false; render(); return;
          }
          if (t.hasAttribute('data-wsave')) {
            capture(); w.busy = true; render();
            const position = (w.order.indexOf('new') + 1) * 10;
            const body = { name: w.name, kind: w.kind.kind, position, enabled: w.enable, config: w.config };
            if (w.reason) body.reason = w.reason;
            if (w.test && w.test.result && w.test.result.ok && w.test.username && w.kind.signIn === 'password') body.test = { username: w.test.username };
            let created;
            try { created = await App.post('/api/admin/identity-providers', body); } catch (err) { w.busy = false; render(); errBox(problemHtml(err)); return; }
            const failed = [];
            for (const mp of w.mappings.filter((x) => x.group.trim())) { try { await App.post('/api/admin/group-mappings', { providerId: created.id, group: mp.group.trim(), role: mp.role, clearance: mp.clearance }); } catch (err) { failed.push(mp.group + ': ' + detailOf(err)); } }
            try { await App.put('/api/admin/identity-providers/order', { ids: w.order.map((id) => (id === 'new' ? created.id : id)).concat(archivedIds), reason: 'sign-in order set in the store wizard' }); } catch (err) { failed.push('Sign-in order: ' + detailOf(err)); }
            App.closeOverlay();
            ctx.toast('Store ' + esc(created.name) + ' added.' + (failed.length ? ' Not done: ' + esc(failed.join('; ')) : ''), failed.length ? 'warn' : 'ok');
            if (opts.onDone) opts.onDone(created);
          }
        });
        render();
      } });
    }
  };

  // ---------- the form editor (B-181) ----------
  App.storeEditor = function (ctx, store, opts) {
    opts = opts || {};
    loadKinds().then((reg) => {
      const kind = reg.kinds.find((k) => k.kind === store.kind);
      const e = { tab: kind ? 'form' : 'json', config: clone(store.config), name: store.name, errors: [], versions: null };
      ctx.modal({ cls: 'wide', title: 'Edit ' + esc(store.name), body: CSS + '<div data-ed class="vstack gap12"></div>', onMount(m) {
        const root = m.querySelector('[data-ed]');
        const render = () => {
          let body = UI.seg([].concat(kind ? [{ id: 'form', label: 'Form' }] : [], [{ id: 'json', label: 'JSON (advanced)' }, { id: 'versions', label: 'Versions' }]), e.tab, 'aria-label="Editor"');
          if (e.tab === 'form') body += UI.field('Name', UI.input(e.name, { attrs: 'data-ename maxlength="100"' })) + formHtml(kind, null, e.config, e.errors);
          else if (e.tab === 'json') body += UI.field('Name', UI.input(e.name, { attrs: 'data-ename maxlength="100"' })) + UI.field('Configuration (JSON)', UI.textarea(JSON.stringify(e.config, null, 2), { attrs: 'data-ejson spellcheck="false" style="font-family:var(--mono);font-size:12px"', rows: 16 }), 'Secrets as references only.');
          else {
            if (!e.versions) { body += UI.notice('Loading versions…', 'info'); App.get('/api/admin/identity-providers/' + enc(store.id) + '/versions').then((r) => { e.versions = r; render(); }).catch((err) => { e.versions = { available: false, versions: [], error: detailOf(err) }; render(); }); }
            else if (!e.versions.available) body += UI.notice(e.versions.error ? esc(e.versions.error) : 'Versions are kept once the database migration 140_identity_store_state is applied.', 'info');
            else body += e.versions.versions.length ? e.versions.versions.map((v) => '<div class="panel stw-wrap"><div class="hstack wrap gap6"><b>Version ' + v.version + '</b><span class="muted" style="font-size:12px">' + esc(when(v.createdAt)) + '</span>' + (v.reason ? '<span class="fg2" style="font-size:12px">' + esc(v.reason) + '</span>' : '') + '</div>'
              + (v.changes.length ? UI.table(['Setting', 'Before', 'After'], v.changes.map((c) => ['<span class="mono">' + esc(c.path) + '</span>', '<span class="mono">' + esc(JSON.stringify(c.before)) + '</span>', '<span class="mono">' + esc(JSON.stringify(c.after)) + '</span>']), { minWidth: '0', cls: 'bare', clickable: false }) : '<div class="muted" style="font-size:12px">No change.</div>') + '</div>').join('') : UI.empty('No versions yet', 'A version is kept with each saved change.');
          }
          if (e.tab !== 'versions') body += UI.field('Reason (kept with the version)', UI.input('', { attrs: 'data-ereason maxlength="500"' }));
          body += '<div data-eerr></div><div class="hstack wrap gap6" style="justify-content:flex-end">' + UI.btn('Close', { attrs: 'data-close' }) + (e.tab !== 'versions' ? UI.btn('Save', { kind: 'primary', attrs: 'data-esave' }) : '') + '</div>';
          root.innerHTML = body;
        };
        const capture = () => {
          const n = root.querySelector('[data-ename]'); if (n) e.name = n.value.trim();
          const j = root.querySelector('[data-ejson]');
          if (j) { try { e.config = JSON.parse(j.value || '{}'); } catch (x) { root.querySelector('[data-eerr]').innerHTML = UI.notice('The configuration is not valid JSON: ' + esc(x.message), 'danger'); return false; } }
          else if (e.tab === 'form') readForm(root, e.config);
          return true;
        };
        root.addEventListener('click', async (ev) => {
          const t = ev.target.closest('button'); if (!t) return;
          if (t.dataset.seg) { if (!capture()) return; e.tab = t.dataset.seg; render(); return; }
          if (t.hasAttribute('data-esave')) {
            const reason = root.querySelector('[data-ereason]').value.trim();
            if (!capture()) return;
            try {
              const saved = await App.patch('/api/admin/identity-providers/' + enc(store.id), Object.assign({ name: e.name, config: e.config }, reason ? { reason } : {}));
              App.closeOverlay();
              // QA-1: under dual control the configuration waits for a second identity admin (Governance tab).
              if (saved && saved.proposal) ctx.toast('The configuration change waits for a second identity admin. It is listed under Governance.', 'ok', 7000);
              else ctx.toast('Store saved as a new version.', 'ok');
              govCache = null; if (opts.onDone) opts.onDone();
            } catch (err) {
              const p = err.problem || {}; e.errors = p.errors || [];
              if (e.tab === 'form') render();
              root.querySelector('[data-eerr]').innerHTML = UI.notice('<b>' + esc(detailOf(err)) + '</b>' + (p.errors ? '<ul style="margin:4px 0 0;padding-left:18px">' + p.errors.map((x) => '<li><span class="mono">' + esc(x.path) + '</span>: ' + esc(x.message) + '</li>').join('') + '</ul>' : ''), 'danger');
            }
          }
        });
        render();
      } });
    }).catch((err) => App.fail(err, 'The store kinds could not be loaded'));
  };

  // ---------- step-up for archive, restore and restoring a backup ----------
  const CANCELLED = {};
  const stepUp = (ctx) => new Promise((resolve) => {
    const methods = (App.me && App.me.stepUp && App.me.stepUp.methods) || ['password'];
    const pw = methods.indexOf('password') >= 0; const totp = methods.indexOf('totp') >= 0;
    let ok = false;
    ctx.modal({ title: 'Confirm it is you',
      body: '<div class="fg2">Archiving, restoring and restoring a backup need a fresh check of who you are.</div>'
        + (pw ? UI.field('Password', UI.input('', { type: 'password', attrs: 'data-supw autocomplete="current-password"' })) : '')
        + (totp ? UI.field('Authenticator code', UI.input('', { attrs: 'data-sucode inputmode="numeric" maxlength="6" autocomplete="one-time-code"' })) : '')
        + '<div data-suerr role="alert"></div>',
      actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Confirm', { kind: 'primary', attrs: 'data-sugo' }),
      onMount(m) {
        m.querySelector('[data-sugo]').addEventListener('click', async () => {
          const pwv = m.querySelector('[data-supw]') ? m.querySelector('[data-supw]').value : '';
          const code = m.querySelector('[data-sucode]') ? m.querySelector('[data-sucode]').value.trim() : '';
          if (!pwv && !code) { m.querySelector('[data-suerr]').innerHTML = UI.notice('Enter your password or a code.', 'warn'); return; }
          try { await App.post('/api/me/step-up', pwv ? { password: pwv } : { code }); ok = true; App.closeOverlay(); } catch (e) { m.querySelector('[data-suerr]').innerHTML = UI.notice(esc(detailOf(e)), 'danger'); }
        });
      },
      onClose() { resolve(ok); } });
  });
  const withStepUp = async (ctx, fn) => {
    try { return await fn(); } catch (err) {
      if (!(err && err.problem && err.problem.step_up)) throw err;
      if (!(await stepUp(ctx))) return CANCELLED;
      return fn();
    }
  };

  // ---------- the inspector's extras and the Archived list (B-185, B-186) ----------
  App.storeInspectorExtras = function (sel) {
    if (!sel) return '';
    const gov = governance();
    const more = gov && gov.available ? UI.btn('Backup schedule', { size: 'sm', kind: 'ghost', attrs: 'data-sschedule' }) + (App.can('users:manage') ? UI.btn('Export users (CSV)', { size: 'sm', kind: 'ghost', icon: 'download', attrs: 'data-sexport' }) : '') : '';
    if (sel.state === 'archived') {
      const at = gov && gov.available && sel.archivedAt ? sel.archivedAt + gov.settings.purgeAfterDays * 86400000 : null;
      return UI.notice('Archived ' + esc(when(sel.archivedAt)) + '. It is out of the sign-in chain and sync; its configuration, mappings and links are kept read-only. Restore puts it back ' + (sel.stateBefore === 'disabled' ? 'disabled' : 'enabled') + ', as it was.' + (at ? ' It can be purged from ' + esc(when(at)) + '.' : ''), 'warn')
        + '<div class="hstack wrap gap6">' + UI.btn('Restore', { size: 'sm', icon: 'refresh', attrs: 'data-srestore' }) + UI.btn('Restore disabled for review', { size: 'sm', kind: 'ghost', attrs: 'data-srestore="disabled"' }) + UI.btn('Back up', { size: 'sm', kind: 'ghost', icon: 'download', attrs: 'data-sbackup' }) + more
        + (gov && gov.available && sel.managedBy !== 'config' ? UI.btn('Purge', { size: 'sm', kind: 'ghost', icon: 'trash', attrs: 'data-spurge' + (at && at > Date.now() ? ' aria-describedby="stg-purge-note"' : '') }) : '') + '</div>'
        + (at && at > Date.now() ? '<div id="stg-purge-note" class="muted" style="font-size:12px">Purging is refused until ' + esc(when(at)) + ' (' + gov.settings.purgeAfterDays + ' days after archiving).</div>' : '');
    }
    return '<div class="hstack wrap gap6">' + (sel.managedBy === 'config' || sel.kind === 'local' ? '' : UI.btn('Archive', { size: 'sm', kind: 'ghost', attrs: 'data-sarchive' })) + UI.btn('Back up', { size: 'sm', kind: 'ghost', icon: 'download', attrs: 'data-sbackup' }) + UI.btn('Versions', { size: 'sm', kind: 'ghost', attrs: 'data-sversions' }) + more + '</div>';
  };

  App.storeArchived = function (archived, sel) {
    if (!archived.length) return '';
    return '<div class="eyebrow">Archived</div>' + UI.table(['Name', 'Kind', 'Archived', 'Was'], archived.map((p) => ({ cells: [esc(p.name), esc(p.kind), esc(when(p.archivedAt)), esc(p.stateBefore || 'enabled')], attrs: 'data-store="' + esc(p.id) + '"', selected: sel && sel.id === p.id })), { minWidth: '0', emptyTitle: '', emptyText: '' });
  };

  const download = (name, data) => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };
  const fileOf = (name, id) => 'store-' + String(name || 'store').toLowerCase().replace(/[^a-z0-9-]+/g, '-') + '-' + id + '.json';

  App.storeHandlers = function (ctx, h) {
    const sel = h.sel; if (!sel) return;
    ctx.on('click', '[data-sarchive]', async () => {
      let opts = { revokeSessions: false, revokeApiKeys: false, reason: '' };
      const keep = (ev) => { const t = ev.target; if (!t || !t.hasAttribute) return; if (t.hasAttribute('data-arsess')) opts.revokeSessions = t.checked; if (t.hasAttribute('data-arkeys')) opts.revokeApiKeys = t.checked; if (t.hasAttribute('data-arreason')) opts.reason = t.value.trim(); };
      document.addEventListener('input', keep); document.addEventListener('change', keep);
      const ok = await ctx.confirm({ title: 'Archive ' + sel.name + '?', tag: 'leaves sign-in', tone: 'danger', body: '<div class="fg2">It leaves the sign-in chain and directory sync. Its users keep their accounts but cannot sign in through it; anyone with another way in (a local password, another store) still can. Its configuration, mappings and links are kept read-only, and you can restore it.</div>'
        + UI.check('Also end the sessions started through it', false, 'data-arsess') + UI.check('Also revoke the API keys of users who have no other store', false, 'data-arkeys') + UI.field('Reason', UI.input('', { attrs: 'data-arreason maxlength="500"' })), ok: 'Archive' });
      document.removeEventListener('input', keep); document.removeEventListener('change', keep);
      if (!ok) return;
      try {
        const r = await withStepUp(ctx, () => App.post('/api/admin/identity-providers/' + enc(sel.id) + '/archive', Object.assign({ revokeSessions: opts.revokeSessions, revokeApiKeys: opts.revokeApiKeys }, opts.reason ? { reason: opts.reason } : {})));
        if (r === CANCELLED) return;
        ctx.toast(esc(sel.name) + ' archived. ' + r.users + ' user' + (r.users === 1 ? '' : 's') + ' kept' + (r.sessionsRevoked ? ', ' + r.sessionsRevoked + ' session' + (r.sessionsRevoked === 1 ? '' : 's') + ' ended' : '') + (r.apiKeysRevoked ? ', ' + r.apiKeysRevoked + ' API key' + (r.apiKeysRevoked === 1 ? '' : 's') + ' revoked' : '') + '.', 'ok');
        h.reload();
      } catch (err) { App.fail(err, 'Not archived'); }
    });
    ctx.on('click', '[data-srestore]', async (e, t) => {
      const to = t.dataset.srestore === 'disabled' ? 'disabled' : 'previous';
      try {
        const r = await withStepUp(ctx, () => App.post('/api/admin/identity-providers/' + enc(sel.id) + '/restore', { to }));
        if (r === CANCELLED) return;
        ctx.toast(esc(sel.name) + ' restored ' + (r.store.enabled ? 'enabled' : 'disabled') + '.', 'ok'); h.reload();
      } catch (err) { App.fail(err, 'Not restored'); }
    });
    ctx.on('click', '[data-sversions]', () => { App.storeEditor(ctx, sel, { onDone: h.reload }); });
    ctx.on('click', '[data-sbackup]', () => {
      ctx.modal({ title: 'Back up ' + esc(sel.name), body: '<div class="fg2">A sealed, signed archive of this store: its configuration versions (secrets stay references), group mappings and identity links' + (sel.kind === 'local' || sel.kind === 'sql' ? ', and its accounts\' records with their password hashes (local) and second factors' : '') + '. It opens only on this installation, in any of its tenants.</div>',
        actions: UI.btn('Cancel', { attrs: 'data-close' }) + UI.btn('Download', { icon: 'download', attrs: 'data-bdl' }) + UI.btn('Save to the blob store', { kind: 'primary', attrs: 'data-bsave' }),
        onMount(m) {
          m.querySelector('[data-bdl]').addEventListener('click', async () => { try { const a = await App.post('/api/admin/identity-providers/' + enc(sel.id) + '/backups', {}); download(fileOf(sel.name, a.id), a); App.closeOverlay(); ctx.toast('Backup downloaded. Audit entry written.', 'ok'); } catch (err) { App.fail(err, 'No backup'); } });
          m.querySelector('[data-bsave]').addEventListener('click', async () => { try { await App.post('/api/admin/identity-providers/' + enc(sel.id) + '/backups', { save: true }); App.closeOverlay(); ctx.toast('Backup saved. It is listed under Backups.', 'ok'); if (h.st) h.st.storeBackups = null; h.reload(); } catch (err) { App.fail(err, 'No backup'); } });
        } });
    });
  };

  // ---------- governance (QA-1): settings, proposals, purge, schedules, exports ----------
  let govCache = null; let govLoading = false;
  /** The tenant's store governance (settings, dual control in force), loaded once and re-rendered into. */
  function governance() {
    if (govCache || govLoading) return govCache;
    govLoading = true;
    App.get('/api/admin/identity-store-governance').then((r) => { govCache = r; }).catch(() => { govCache = { available: false, settings: { dualControl: 'auto', purgeAfterDays: 30 }, dualControl: { on: false, warning: null } }; })
      .then(() => { govLoading = false; if (App.state.route === 'directories' && !document.querySelector('#overlay .modal, #overlay .drawer')) App.render(); });
    return null;
  }
  const problemError = (res, body) => { const e = new Error((body && (body.detail || body.title)) || 'Request failed'); e.status = res.status; e.problem = body || {}; return e; };
  const saveText = (name, text, type) => {
    const url = URL.createObjectURL(new Blob([text], { type: type || 'text/csv' }));
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };
  const KIND_LABEL = { 'store.config': 'Configuration change', 'store.restore': 'Backup restore', 'store.purge': 'Purge', settings: 'Settings' };

  /** With migration 142 a store is removed by archiving it and purging it later, so "Remove" is not offered. */
  App.storeRemovable = function () { const g = governance(); return !(g && g.available); };

  App.storeGovernanceHandlers = function (ctx, h) {
    const sel = h.sel; if (!sel) return;
    ctx.on('click', '[data-spurge]', async () => {
      const ok = await ctx.confirm({ title: 'Purge ' + sel.name + '?', tag: 'cannot be undone', tone: 'danger', body: '<div class="fg2">Its identity links, group mappings, versions and backup schedule go. The accounts stay but lose this store\'s identity. Saved backups are kept.' + (governance() && governance().dualControl.on ? ' A second identity admin must approve it.' : '') + '</div>', ok: 'Purge store' });
      if (!ok) return;
      try {
        const r = await withStepUp(ctx, () => App.post('/api/admin/identity-providers/' + enc(sel.id) + '/purge', {}));
        if (r === CANCELLED) return;
        govCache = null;
        if (r.proposal) ctx.toast('The purge waits for a second identity admin. It is listed under Governance.', 'ok', 7000);
        else { ctx.toast(esc(sel.name) + ' purged. ' + r.links + ' identity link' + (r.links === 1 ? '' : 's') + ' removed; the accounts stay.', 'ok'); if (h.st) h.st.sel = null; }
        h.reload();
      } catch (err) { App.fail(err, 'Not purged'); }
    });
    ctx.on('click', '[data-sschedule]', async () => {
      let cur = null; try { cur = (await App.get('/api/admin/identity-providers/' + enc(sel.id) + '/backup-schedule')).schedule; } catch (err) { App.fail(err); return; }
      ctx.modal({ title: 'Backup schedule of ' + esc(sel.name),
        body: '<div class="fg2">Scheduled backups are saved to the blob store, sealed and signed like one made by hand. Only scheduled backups are pruned; a failed run notifies the identity admins.</div>'
          + (cur ? UI.kv([['Next run', esc(when(cur.nextRunAt))], ['Last run', cur.lastRunAt ? esc(when(cur.lastRunAt)) + ' ' + UI.pill(cur.lastStatus || '', cur.lastStatus === 'ok' ? 'ok' : 'danger') : 'not yet']].concat(cur.lastError ? [['Last error', esc(cur.lastError)]] : []), 2) : '')
          + '<div class="formgrid" style="--cols:3">' + UI.field('Frequency', UI.select([{ value: 'daily', label: 'Daily' }, { value: 'weekly', label: 'Weekly' }], cur ? cur.frequency : 'daily', 'data-schfreq'))
          + UI.field('Backups to keep', UI.input(cur && cur.keepCount != null ? String(cur.keepCount) : (cur ? '' : '7'), { type: 'number', attrs: 'data-schcount min="1" max="365" inputmode="numeric"' }))
          + UI.field('Days to keep', UI.input(cur && cur.keepDays != null ? String(cur.keepDays) : '', { type: 'number', attrs: 'data-schdays min="1" max="3650" inputmode="numeric"' })) + '</div>'
          + UI.check('Enabled', cur ? cur.enabled : true, 'data-schon') + '<div data-scherr role="alert"></div>',
        actions: UI.btn('Cancel', { attrs: 'data-close' }) + (cur ? UI.btn('Run now', { attrs: 'data-schrun' }) + UI.btn('Remove schedule', { kind: 'ghost', attrs: 'data-schdel' }) : '') + UI.btn('Save schedule', { kind: 'primary', attrs: 'data-schsave' }),
        onMount(m) {
          const num = (sel2) => { const v = m.querySelector(sel2).value.trim(); return v ? Number(v) : null; };
          m.querySelector('[data-schsave]').addEventListener('click', async () => {
            try { await App.put('/api/admin/identity-providers/' + enc(sel.id) + '/backup-schedule', { frequency: m.querySelector('[data-schfreq]').value, keepCount: num('[data-schcount]'), keepDays: num('[data-schdays]'), enabled: m.querySelector('[data-schon]').checked }); App.closeOverlay(); ctx.toast('Backup schedule saved.', 'ok'); if (h.st) h.st.storeSchedules = null; }
            catch (err) { m.querySelector('[data-scherr]').innerHTML = UI.notice(esc(detailOf(err)), 'danger'); }
          });
          const run = m.querySelector('[data-schrun]'); if (run) run.addEventListener('click', async () => { try { await App.post('/api/admin/identity-providers/' + enc(sel.id) + '/backup-schedule/run', {}); App.closeOverlay(); ctx.toast('A scheduled backup was queued. It is listed under Backups when it is done.', 'ok'); if (h.st) h.st.storeBackups = null; } catch (err) { m.querySelector('[data-scherr]').innerHTML = UI.notice(esc(detailOf(err)), 'danger'); } });
          const del = m.querySelector('[data-schdel]'); if (del) del.addEventListener('click', async () => { try { await App.del('/api/admin/identity-providers/' + enc(sel.id) + '/backup-schedule'); App.closeOverlay(); ctx.toast('Backup schedule removed. Saved backups are kept.', 'ok'); if (h.st) h.st.storeSchedules = null; } catch (err) { m.querySelector('[data-scherr]').innerHTML = UI.notice(esc(detailOf(err)), 'danger'); } });
        } });
    });
    ctx.on('click', '[data-sexport]', async () => {
      const ok = await ctx.confirm({ title: 'Export the users of ' + sel.name + '?', tag: 'audited', body: '<div class="fg2">A CSV of the accounts linked to this store: username, display name, email, state, groups and last sign-in. No passwords, factors or keys. Accounts above your clearance are left out. A large store is exported by a job.</div>', ok: 'Export CSV' });
      if (!ok) return;
      const call = (method, url, body) => fetch(url, { method, credentials: 'same-origin', headers: Object.assign({ 'X-CSRF-Token': App.state.csrf || '', Accept: 'text/csv, application/json' }, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
      try {
        const res = await call('POST', '/api/admin/identity-providers/' + enc(sel.id) + '/users-export', {});
        if (res.status === 200) { saveText('store-' + String(sel.name).toLowerCase().replace(/[^a-z0-9-]+/g, '-') + '-users.csv', await res.text()); ctx.toast('Users exported' + (Number(res.headers.get('X-Omitted') || 0) ? '; ' + res.headers.get('X-Omitted') + ' above your clearance left out' : '') + '. Audit entry written.', 'ok'); return; }
        const out = await res.json().catch(() => ({}));
        if (res.status !== 202) throw problemError(res, out);
        ctx.toast('The export runs as a job; it downloads here when it is ready.', 'ok');
        for (let i = 0; i < 90; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          const f = await call('GET', '/api/admin/identity-store-exports/' + enc(out.jobId));
          if (f.status === 409) continue;
          if (!f.ok) throw problemError(f, await f.json().catch(() => ({})));
          saveText('store-' + String(sel.name).toLowerCase().replace(/[^a-z0-9-]+/g, '-') + '-users.csv', await f.text()); ctx.toast('Users exported. Audit entry written.', 'ok'); return;
        }
        ctx.toast('The export is still running. Try again from the store\'s panel later.', 'warn');
      } catch (err) { App.fail(err, 'Not exported'); }
    });
  };

  App.storeGovernanceTab = function (ctx, st, reload) {
    const g = st.storeGov;
    if (!g) {
      Promise.all([App.get('/api/admin/identity-store-governance'), App.get('/api/admin/identity-store-proposals').catch(() => []), App.get('/api/admin/identity-store-backup-schedules').catch(() => ({ schedules: [] }))])
        .then(([gov, proposals, sch]) => { st.storeGov = { gov, proposals, schedules: sch.schedules || [] }; govCache = gov; })
        .catch((err) => { st.storeGov = { gov: { available: false, error: detailOf(err) }, proposals: [], schedules: [] }; })
        .then(() => { if (App.state.route === 'directories') ctx.rerender(); });
      return UI.notice('Loading…', 'info');
    }
    const gov = g.gov;
    const storeName = (id) => (id ? ((st.providers || []).find((p) => p.id === id) || { name: 'removed store' }).name : '');
    if (!gov.available) return UI.notice(gov.error ? esc(gov.error) : 'Dual control, purge rules, scheduled backups and user exports need the database migration 142_identity_store_governance. Until it is applied, stores are changed, restored and removed as before.', 'info');
    const dc = gov.dualControl;
    const pending = g.proposals.filter((x) => x.state === 'pending');
    const decided = g.proposals.filter((x) => x.state !== 'pending').slice(0, 20);
    const changesHtml = (x) => (x.changes && x.changes.length ? '<ul class="stg-changes">' + x.changes.map((c) => '<li><span class="mono">' + esc(c.path) + '</span>: <span class="mono">' + esc(JSON.stringify(c.before)) + '</span> → <span class="mono">' + esc(JSON.stringify(c.after)) + '</span></li>').join('') + '</ul>' : '');
    const html = '<style>#main .stg-changes{margin:4px 0 0;padding-left:18px;font-size:12px}#main .stg-changes li,#main .stg-wrap{overflow-wrap:anywhere;min-width:0}</style>'
      + (dc.warning ? UI.notice(esc(dc.warning), 'warn') : UI.notice('Dual control is on: a change of a store\'s connection or attributes, a backup restore, a purge and turning dual control off each need a second identity admin, who approves with a recent sign-in. Names, sign-in order and enabling or disabling a store need one admin.', 'info'))
      + UI.panel('Settings', '<div class="formgrid" style="--cols:2">' + UI.field('Dual control', UI.select([{ value: 'auto', label: 'Automatic: on with two or more identity admins' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off (single-admin installations)' }], gov.settings.dualControl, 'data-gdual'), dc.identityAdmins + ' identity admin' + (dc.identityAdmins === 1 ? '' : 's') + ' in this tenant; dual control is ' + (dc.on ? 'on' : 'off') + ' now.')
        + UI.field('Keep archived stores for (days)', UI.input(String(gov.settings.purgeAfterDays), { type: 'number', attrs: 'data-gdays min="1" max="3650" inputmode="numeric"' }), 'An archived store can be purged only after this.') + '</div>'
        + '<div>' + UI.btn('Save settings', { kind: 'primary', size: 'sm', attrs: 'data-gsave' }) + '</div>')
      + '<div class="eyebrow">Waiting for approval</div>'
      + UI.table(['Change', 'Store', 'Summary', 'Proposed', { label: '', right: true }], pending.map((x) => ({ cells: [esc(KIND_LABEL[x.kind] || x.kind), esc(storeName(x.providerId) || x.name), '<div class="stg-wrap">' + esc(x.summary || '') + changesHtml(x) + '</div>', esc(when(x.proposedAt)) + (x.mine ? ' ' + UI.pill('yours', 'outline') : ''),
        '<span class="hstack wrap" style="justify-content:flex-end;gap:4px">' + (x.mine ? UI.btn('Withdraw', { size: 'sm', kind: 'ghost', attrs: 'data-gwithdraw="' + esc(x.id) + '"' }) : UI.btn('Approve', { size: 'sm', kind: 'primary', attrs: 'data-gapprove="' + esc(x.id) + '"' }) + UI.btn('Reject', { size: 'sm', kind: 'ghost', attrs: 'data-greject="' + esc(x.id) + '"' })) + '</span>'] })), { minWidth: '0', clickable: false, emptyTitle: 'Nothing waiting', emptyText: 'Changes that need a second identity admin show here.' })
      + (decided.length ? '<div class="eyebrow">Decided</div>' + UI.table(['Change', 'Store', 'State', 'Decided'], decided.map((x) => [esc(KIND_LABEL[x.kind] || x.kind), esc(storeName(x.providerId) || x.name), UI.pill(x.state, x.state === 'approved' ? 'ok' : x.state === 'rejected' ? 'danger' : ''), esc(when(x.decidedAt))]), { minWidth: '0', clickable: false, cls: 'bare' }) : '')
      + '<div class="eyebrow">Backup schedules</div>'
      + UI.table(['Store', 'Frequency', 'Keeps', 'Next run', 'Last run'], g.schedules.map((x) => [esc(storeName(x.providerId)), esc(x.frequency), esc([x.keepCount != null ? x.keepCount + ' backups' : '', x.keepDays != null ? x.keepDays + ' days' : ''].filter(Boolean).join(', ')), x.enabled ? esc(when(x.nextRunAt)) : UI.pill('paused'), x.lastRunAt ? esc(when(x.lastRunAt)) + ' ' + UI.pill(x.lastStatus || '', x.lastStatus === 'ok' ? 'ok' : 'danger') : 'not yet']), { minWidth: '0', clickable: false, emptyTitle: 'No backup schedules', emptyText: 'Set one from a store\'s panel on the Stores tab.' });
    const again = () => { st.storeGov = null; govCache = null; ctx.rerender(); };
    ctx.on('click', '[data-gsave]', async () => {
      const body = { dualControl: ctx.$('[data-gdual]').value, purgeAfterDays: Number(ctx.$('[data-gdays]').value) };
      try {
        const r = await withStepUp(ctx, () => App.put('/api/admin/identity-store-governance', body));
        if (r === CANCELLED) return;
        ctx.toast(r.proposal ? 'Turning dual control off waits for a second identity admin.' : 'Settings saved. Audit entry written.', 'ok'); again();
      } catch (err) { App.fail(err, 'Not saved'); }
    });
    ctx.on('click', '[data-gapprove]', async (e, t) => {
      const x = pending.find((y) => y.id === t.dataset.gapprove); if (!x) return;
      const ok = await ctx.confirm({ title: 'Approve this change?', tag: KIND_LABEL[x.kind] || x.kind, body: '<div class="fg2 stg-wrap">' + esc(x.summary || '') + '</div>' + changesHtml(x), ok: 'Approve' });
      if (!ok) return;
      try { const r = await withStepUp(ctx, () => App.post('/api/admin/identity-store-proposals/' + enc(x.id) + '/approve', {})); if (r === CANCELLED) return; ctx.toast('Approved and applied. Audit entry written.', 'ok'); st.storeBackups = null; again(); reload(); } catch (err) { App.fail(err, 'Not approved'); again(); }
    });
    ctx.on('click', '[data-greject]', async (e, t) => { const ok = await ctx.confirm({ title: 'Reject this change?', tone: 'danger', ok: 'Reject' }); if (!ok) return; try { await App.post('/api/admin/identity-store-proposals/' + enc(t.dataset.greject) + '/reject', {}); ctx.toast('Rejected. The proposer was told.', 'ok'); again(); } catch (err) { App.fail(err); } });
    ctx.on('click', '[data-gwithdraw]', async (e, t) => { try { await App.post('/api/admin/identity-store-proposals/' + enc(t.dataset.gwithdraw) + '/withdraw', {}); ctx.toast('Withdrawn.', 'ok'); again(); } catch (err) { App.fail(err); } });
    return html;
  };

  // ---------- the Backups tab (B-186) ----------
  App.storeBackupsTab = function (ctx, st, reload) {
    const b = st.storeBackups;
    if (!b) { App.get('/api/admin/identity-store-backups').then((r) => { st.storeBackups = r; }).catch((err) => { st.storeBackups = { available: false, backups: [], error: detailOf(err) }; }).then(() => { if (App.state.route === 'directories') ctx.rerender(); }); return UI.notice('Loading…', 'info'); }
    const report = st.storeRestore;
    const html = (b.available ? '' : UI.notice(b.error ? esc(b.error) : 'Saved backups need the database migration 141_identity_store_backups. A backup can still be downloaded from a store, and restored from a file.', 'info'))
      + UI.table(['Store', 'Kind', 'Made', 'Holds', { label: '', right: true }], b.backups.map((x) => ({ cells: [esc(x.providerName), esc(x.kind), esc(when(x.createdAt)), esc(Object.keys(x.counts).filter((k) => x.counts[k]).map((k) => x.counts[k] + ' ' + k).join(', ') || 'configuration'), '<span class="hstack wrap" style="justify-content:flex-end;gap:4px">' + UI.btn('Restore…', { size: 'sm', attrs: 'data-brestore="' + esc(x.id) + '"' }) + UI.btn('Download', { size: 'sm', kind: 'ghost', attrs: 'data-bget="' + esc(x.id) + '"' }) + UI.btn('Delete', { size: 'sm', kind: 'ghost', attrs: 'data-bdel="' + esc(x.id) + '"' }) + '</span>'] })), { minWidth: '0', clickable: false, emptyTitle: 'No saved backups', emptyText: 'Back up a store from its panel on the Stores tab.' })
      + UI.panel('Restore from a file', '<div class="fg2" style="font-size:12px">A store backup downloaded from this installation (any tenant), up to 50 MB. Its signature is checked first; a changed file is refused. A restore is previewed first' + (governance() && governance().dualControl.on ? ', and needs a second identity admin to approve it' : '') + '.</div>' + UI.field('Backup file', '<input type="file" accept="application/json,.json" data-bfile>') + '<div>' + UI.btn('Preview restore', { size: 'sm', attrs: 'data-bfilego' }) + '</div>')
      + (report ? UI.panel('Restore ' + (report.dryRun ? 'preview' : 'done'), UI.kv([['Into', esc(report.target.name) + (report.target.created ? ' (a new store, disabled)' : '')], ['From', esc(report.backup.source.store.name) + ' of tenant ' + esc(report.backup.source.tenant.slug || report.backup.source.tenant.id)], ['Made', esc(when(report.backup.createdAt))]], 2)
        + (report.warnings.length ? UI.notice(report.warnings.map(esc).join('<br>'), 'warn') : '')
        + UI.table(['What', 'Change', 'Detail'], report.changes.map((c) => [esc(c.what), UI.pill(c.action, c.action === 'create' || c.action === 'update' ? 'accent' : c.action === 'skip' ? 'warn' : ''), '<span class="stw-wrap">' + esc(c.detail) + '</span>']), { minWidth: '0', clickable: false, cls: 'bare' })
        + (report.dryRun ? '<div class="hstack wrap gap6">' + UI.btn('Restore into the same store', { kind: 'primary', size: 'sm', attrs: 'data-bgo="same"' }) + UI.btn('Restore as a new store', { size: 'sm', attrs: 'data-bgo="new"' }) + UI.btn('Discard', { size: 'sm', kind: 'ghost', attrs: 'data-bdiscard' }) + '</div>' : '')) : '');
    const run = async (source, mode, dryRun) => {
      try {
        const r = await withStepUp(ctx, () => App.post('/api/admin/identity-store-backups/restore', Object.assign({ mode, dryRun }, source)));
        if (r === CANCELLED) return;
        st.storeRestore = r; st.storeRestoreSource = source;
        if (!dryRun && r.proposal) { st.storeRestore = null; govCache = null; st.storeBackups = null; ctx.toast('The restore waits for a second identity admin. It is listed under Governance.', 'ok', 7000); reload(); return; }
        if (!dryRun) { ctx.toast('Backup restored into ' + esc(r.target.name) + '. Audit entry written.', 'ok'); st.storeBackups = null; reload(); return; }
        ctx.rerender();
      } catch (err) { App.fail(err, 'Not restored'); }
    };
    ctx.on('click', '[data-brestore]', (e, t) => run({ backupId: t.dataset.brestore }, 'same', true));
    ctx.on('click', '[data-bgo]', (e, t) => run(st.storeRestoreSource, t.dataset.bgo, false));
    ctx.on('click', '[data-bdiscard]', () => { st.storeRestore = null; ctx.rerender(); });
    ctx.on('click', '[data-bget]', async (e, t) => { try { const a = await App.get('/api/admin/identity-store-backups/' + enc(t.dataset.bget) + '/download'); download(fileOf(a.source.store.name, a.id), a); } catch (err) { App.fail(err); } });
    ctx.on('click', '[data-bdel]', async (e, t) => { const ok = await ctx.confirm({ title: 'Delete this backup?', tag: 'cannot be undone', tone: 'danger', ok: 'Delete backup' }); if (!ok) return; try { await App.del('/api/admin/identity-store-backups/' + enc(t.dataset.bdel)); st.storeBackups = null; ctx.toast('Backup deleted.', 'ok'); ctx.rerender(); } catch (err) { App.fail(err); } });
    ctx.on('click', '[data-bfilego]', async () => {
      const f = ctx.$('[data-bfile]'); const file = f && f.files && f.files[0]; if (!file) { ctx.toast('Choose a backup file.', 'warn'); return; }
      if (b.available) {
        // QA-1 (B-186): streamed to the blob store, so a backup larger than the API's JSON limit restores by id.
        let res; let out;
        try { res = await fetch('/api/admin/identity-store-backups/upload', { method: 'PUT', body: file, credentials: 'same-origin', headers: { 'X-CSRF-Token': App.state.csrf || '', 'Content-Type': 'application/json', Accept: 'application/json' } }); out = await res.json().catch(() => ({})); }
        catch (e) { ctx.toast('The file was not sent: the server could not be reached.', 'danger'); return; }
        if (!res.ok) { App.fail(problemError(res, out), 'Not uploaded'); return; }
        st.storeBackups = null;
        run({ backupId: out.id }, 'same', true);
        return;
      }
      let archive; try { archive = JSON.parse(await file.text()); } catch (e) { ctx.toast('That file is not JSON.', 'warn'); return; }
      run({ archive }, 'same', true);
    });
    return html;
  };
})();
