# Screen module contract

Every screen is one file in `js/screens/<id>.js`, plain ES2017 (no modules, no build step), wrapped in an IIFE that calls `App.register({...})`.
The shell (`js/app.js`) owns the sidebar, header, breadcrumb, command palette (Ctrl K), theme toggle, notifications, toasts, modals, drawers and the "States" popover. A screen owns only the inside of `#main`.

```js
(function () {
  const { UI, DATA } = App;          // string-returning component helpers + shared data
  App.register({
    id: 'models',                    // route: #/models — must match the id in index.html and app.js NAV
    title: 'Models',                 // document title, prototype map
    summary: 'Catalog, import, approvals, placement',   // one line for the prototype map
    section: 'admin',                // 'admin' puts "Admin /" in the breadcrumb; omit for workspace screens
    crumb: ['Admin', 'Models'],      // optional; string[] or (state, params) => string[]
    label: 'confidential',           // optional classification badge in the header; string or (state, params) => string|null
    commands: [ { label: 'Request model import', sub: 'Models', run(app) { ... } } ],  // optional palette commands (screen is navigated to first)
    states: [                        // the "States to design from this page" cards from the board, each clickable
      { title: 'Pickle rejected', tone: 'danger', text: 'Import refused: ...', apply(ctx) { ctx.state.problem = 'pickle'; ctx.rerender(); } }
    ],
    render(root, ctx) { ... }        // build DOM inside root (the #main element, class "main")
  });
})();
```

`ctx` gives you: `ctx.state` (a per-screen object that survives re-renders and navigation, start empty), `ctx.params` (hash query params), `ctx.rerender()`, `ctx.toast(html, kind?, ms?)` (kind: '' | 'ok' | 'warn' | 'danger'), `ctx.modal({title, body, actions, cls:'wide', onMount(modalEl)})`, `ctx.confirm({title, tag, tone:'danger', body, kv:[[k,v]], ok, cancel}) → Promise<boolean>`, `ctx.drawer({title, body, actions, onMount})`, `ctx.navigate(id, params?)`, `ctx.on(event, selector, fn(e, target))` (delegated inside #main), `ctx.$`, `ctx.$$`, `ctx.app` (the App object). Closing: any element with `data-close` inside a modal/drawer closes it; `App.closeOverlay()` too.

## Layout inside `root`

`root` is a flex row. Typical patterns from the boards:

```html
<div class="leftpane">…</div>                 <!-- optional list column (260px; .w320 .w170) -->
<div class="page">…</div>                      <!-- scrolling content; use class "page tight" for edge-to-edge layouts like chat -->
<aside class="inspector w360">…</aside>        <!-- optional inspector (320px default; .w360 .w300) -->
```

Inside `.page`, stack: `UI.pagehead(title, subtitle, actionsHtml)`, a `.toolbar` (search + filter buttons), then tables/panels/grids. Use the CSS classes in `css/app.css`: `.panel`, `.kv`, `.tablewrap > table.dt`, `.tabs`, `.seg`, `.field/.input/.select/.textarea/.toggle/.check`, `.formgrid`, `.meter`, `.notice.{info|warn|danger|ok|accent}`, `.empty`, `.problem`, `.ctxblock`, `.codebox`, `.reviewbar`, `.timeline`, `.stat/.stats`, `.grid2/.grid3/.grid4`, `.cols`, `.hstack/.vstack/.grow/.right/.wrap`, `.eyebrow`, `.mono`, `.serif`, `.muted/.fg2`, `.num`, `.divider`, `.listlink`, `.chip`, `.pill`, `.label`.

## UI helpers (all return HTML strings)

- `UI.esc(s)`; `UI.icon(name, size)` — names: chat compare runs knowledge memory workflows scripts media images models profiles pools registry mcp guardrails flags classifiers connections training tenants identity zones audit platform settings search bell plus x check chev chevd menu sun moon copy refresh edit branch flag attach send play stop pause lock key info warn thumb download filter sort dots link grid clock brain calc eye upload undo map trash
- `UI.label('public'|'internal'|'confidential'|'restricted', {sm})` — the classification badge with bars (colour only on restricted)
- `UI.pill(text, kind?)` — status pill; kind '' | 'info' | 'ok' | 'warn' | 'danger' | 'outline' | 'accent'; kind is inferred from common words (approved→ok, failed→danger, deprecated→warn, in review/running→info…)
- `UI.btn(label, {kind:'primary'|'ghost'|'danger', size:'sm'|'xs', icon, attrs, disabled, cls, title})`, `UI.iconbtn(icon, title, {attrs, cls:'sm ghost', dot})`
- `UI.pagehead(title, subHtml, actionsHtml)`, `UI.panel(eyebrowTitle|null, bodyHtml, {actions, cls, attrs})`
- `UI.kv([[key, valueHtml], …], cols)`
- `UI.table(cols, rows, {selected, clickable, cls, attrs, minWidth, emptyTitle, emptyText})` — `cols`: strings or `{label, right, width}`; `rows`: arrays of cell HTML, or `{cells, attrs, selected}`; rows get `data-row="i"` and class `row` (hover) — wire `ctx.on('click', 'tr.row', …)`
- `UI.tabs([{id,label,count}|string], activeId, attrs)` — buttons with `data-tab`; `UI.seg(items, activeId, attrs)` — `data-seg`
- `UI.field(label, controlHtml, hint)`, `UI.input(value, {type, placeholder, attrs, readonly})`, `UI.textarea(value, {placeholder, attrs, rows})`, `UI.select(options, value, attrs)`, `UI.toggle(label, on, attrs)` (toggles itself on click unless `data-manual`), `UI.check(label, on, attrs)`, `UI.search(placeholder, attrs, value)`
- `UI.meter(label, valueText, pct, tone:'warn'|'accent'|'danger')`, `UI.notice(html, kind, actionHtml)`, `UI.empty(title, text, actionHtml)`, `UI.problem(title, text, traceId)`, `UI.ctx(title, bodyText, level)` (context block), `UI.code(text, lang)`, `UI.reviewbar(html, actionsHtml)`, `UI.stat(nHtml, label, detailHtml)`, `UI.spark([values], hiIndex)`, `UI.timeline([{title, text, meta, tone}])`, `UI.listItem(titleHtml, subHtml, {active, attrs, right})`, `UI.states(list)` (renders the state cards strip; clicking card i calls the state's apply — wire with `ctx.on('click','.state-card', (e,t)=>ctx.app.applyState(+t.dataset.state))`)

## Rules

1. Reproduce the board's content faithfully: same headings, table columns, row values, inspector fields, buttons and notices. Use the outline file for the board as the source of truth. Do not invent new features; do make every control do something (open a drawer, toggle, filter, select a row and update the inspector, confirm, toast, navigate).
2. Row selection updates the inspector in place. Filters and search actually filter the rows. Tabs switch content. Primary actions that change state show a confirm modal, then a toast and a visible change (status pill, row moved, count changed).
3. Keep all copy in the board's voice: plain, specific, no exclamation marks, no lorem ipsum, no emoji.
4. Persist UI state in `ctx.state` so navigating away and back keeps the selection. Re-render with `ctx.rerender()` after state changes (cheap, whole screen).
5. Everything must work in dark theme: only use CSS variables (never literal colours) in inline styles. `var(--fg) --fg2 --muted --faint --line --line2 --panel --panel2 --bg --sel --accent --accent-tint --warn-bg/--warn-fg --danger-bg/--danger-fg --info-bg/--info-fg --ok-bg/--ok-fg --meter`.
6. Cross-link where the board implies it: e.g. a model row's "profile" link → `ctx.navigate('profiles', {profile:'analyst'})`; a flag → `ctx.navigate('flags', {id:'F-2291'})`. Read `ctx.params` on render to preselect.
7. Board sections named "States to design from this page" become the `states` array (title, tone from the heading colour: `#A01E18`→danger, `#7A5200`→warn, `#1C6A38`→ok, `#1B4C8C`→info, else neutral) with an `apply` that makes the screen actually show that state (a notice, a problem panel, a disabled button, a changed pill). Also render `UI.states(list)` at the bottom of the page under an eyebrow "States to design from this page", wired to apply.
8. No external libraries. Inline SVG is fine for graphs and small charts. Keep each file self-contained; do not touch app.js or app.css (ask instead, or add a `<style>` block inside root for screen-only rules, prefixed with the screen id).
9. Escape any text that comes from data with `UI.esc`. Use `type="button"` on buttons.
10. Test by opening `index.html` in a browser (or `node build.mjs` then `dist/index.html`); the file must parse with `node --check`.
