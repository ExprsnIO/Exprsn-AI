// Apps, the formula editor's function list (1.8.0, Sprint 47, B-141): the server's catalogue of formula functions
// (GET /api/apps/formula-functions: name, signature, what it does, an example, by category), searchable, each with an
// Insert button that puts `Name(` at the cursor of the expression; and the server's own check of the expression
// (POST /api/apps/formula-check, 200 with ok or a message), the same parse an entity save makes, with its message about
// argument counts and kinds.
//
// `apps.js` calls App.appsFormula.panel() inside the formula field's editor and App.appsFormula.wire(...) once it is on
// screen. The catalogue is read once per page load.
(function () {
  const { UI, esc } = App;
  const CSS = '.modal .appsf{display:flex;flex-direction:column;gap:6px;min-width:0}'
    + '.modal .appsf-list{display:flex;flex-direction:column;gap:2px;margin:0;padding:0;list-style:none;max-height:240px;overflow:auto;border:1px solid var(--line);border-radius:8px;background:var(--panel2)}'
    + '.modal .appsf-cat{font-size:11px;font-weight:600;color:var(--muted);padding:6px 8px 2px;text-transform:uppercase;letter-spacing:.04em}'
    + '.modal .appsf-item{display:flex;align-items:flex-start;gap:8px;padding:4px 8px;min-width:0}'
    + '.modal .appsf-item .appsf-txt{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px;overflow-wrap:anywhere;font-size:12px}'
    + '.modal .appsf-item .mono{font-size:12px;color:var(--fg)}';
  let catalogue = null;
  let loading = null;

  function load() {
    if (catalogue) return Promise.resolve(catalogue);
    if (!loading) loading = App.get('/api/apps/formula-functions').then((r) => { catalogue = (r && r.functions) || []; return catalogue; }).catch((err) => { loading = null; throw err; });
    return loading;
  }

  /** The lower-case names the advisory check knows, once the catalogue is in (null before). */
  function names() { return catalogue ? catalogue.map((f) => f.call) : null; }

  function panel() {
    return '<div class="span2 appsf" data-fcat><style>' + CSS + '</style>'
      + UI.field('Find a function', UI.input('', { type: 'search', placeholder: 'Name or what it does, such as date or list', attrs: 'data-fcat-q autocomplete="off"' }), 'Names are not case-sensitive. Insert puts the function at the cursor.')
      + '<ul class="appsf-list" data-fcat-list aria-label="Formula functions"><li class="appsf-item muted">Loading the functions…</li></ul>'
      + '<div data-fcheck-server class="muted" style="font-size:12px" aria-live="polite"></div></div>';
  }

  function render(list, q) {
    const needle = (q || '').trim().toLowerCase();
    const hits = list.filter((f) => !needle || f.call.indexOf(needle) >= 0 || f.description.toLowerCase().indexOf(needle) >= 0 || f.category.toLowerCase().indexOf(needle) >= 0);
    if (!hits.length) return '<li class="appsf-item muted">No function matches ' + esc(q) + '.</li>';
    const cats = [];
    hits.forEach((f) => { if (cats.indexOf(f.category) < 0) cats.push(f.category); });
    return cats.map((c) => '<li class="appsf-cat" aria-hidden="true">' + esc(c) + '</li>' + hits.filter((f) => f.category === c).map((f) => '<li class="appsf-item" data-fcat-item="' + esc(f.call) + '">'
      + UI.btn('Insert', { size: 'xs', attrs: 'data-fins="' + esc(f.name) + '" aria-label="Insert ' + esc(f.name) + '"' })
      + '<span class="appsf-txt"><span class="mono">' + esc(f.signature) + '</span><span class="fg2">' + esc(f.description) + '</span><span class="muted mono">' + esc(f.example) + '</span></span></li>').join('')).join('');
  }

  /**
   * Fills the list, wires search and Insert, and checks the expression on the server as it is typed (after a pause).
   * `plain` is the field names a formula may read. `onNames` gets the catalogue's names for the advisory check.
   */
  function wire(host, textarea, plain, onNames) {
    const box = host.querySelector('[data-fcat]'); if (!box || !textarea) return;
    const listEl = box.querySelector('[data-fcat-list]'); const q = box.querySelector('[data-fcat-q]'); const out = box.querySelector('[data-fcheck-server]');
    load().then((list) => {
      if (!document.body.contains(listEl)) return;
      listEl.innerHTML = render(list, q.value);
      if (onNames) onNames(names());
    }).catch(() => { listEl.innerHTML = '<li class="appsf-item muted">The function list could not be loaded; the server still checks the formula on save.</li>'; });
    q.addEventListener('input', () => { if (catalogue) listEl.innerHTML = render(catalogue, q.value); });
    listEl.addEventListener('click', (e) => {
      const b = e.target.closest('[data-fins]'); if (!b) return;
      const name = b.getAttribute('data-fins'); const s = textarea.selectionStart == null ? textarea.value.length : textarea.selectionStart; const t = textarea.selectionEnd == null ? s : textarea.selectionEnd;
      textarea.value = textarea.value.slice(0, s) + name + '(' + textarea.value.slice(t);
      textarea.focus(); const at = s + name.length + 1; try { textarea.setSelectionRange(at, at); } catch (err) { /* not a text control */ }
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    let timer = null; let seq = 0;
    const check = () => {
      const expr = textarea.value; const mine = ++seq;
      if (!expr.trim()) { out.innerHTML = ''; return; }
      App.post('/api/apps/formula-check', { expression: expr, fields: plain }).then((r) => {
        if (mine !== seq || !document.body.contains(out)) return;
        out.innerHTML = r && r.ok ? '<span style="color:var(--ok-fg)">The server reads it' + (r.refs && r.refs.length ? ': it uses ' + esc(r.refs.join(', ')) : '') + '.</span>' : '<span style="color:var(--danger-fg)">' + esc((r && r.message) || 'The server could not read it.') + '</span>';
      }).catch((err) => {
        if (mine !== seq || !document.body.contains(out)) return;
        out.innerHTML = '<span style="color:var(--danger-fg)">' + esc((err && err.message) || 'The server could not check it.') + '</span>';
      });
    };
    textarea.addEventListener('input', () => { if (timer) clearTimeout(timer); timer = setTimeout(check, 400); });
    if (textarea.value.trim()) check();
  }

  App.appsFormula = { panel, wire, load, names };
})();
