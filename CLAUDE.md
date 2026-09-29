# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What's here

Exprsn-AI is planned as a self-hosted, multi-tenant control plane and chat interface for Ollama-served models. Right now the repository holds only a **clickable design prototype** of the console in `design/prototype/`. It has no backend and no product code yet. All data is example data for the "Northwind" tenant, and the only things persisted are the theme and the signed-in flag (both in `localStorage`, key `exprsn.signedIn`).

## Commands

Run these from `design/prototype/`:

```sh
node build.mjs              # regenerate index.html, screens/<id>.html and dist/artifact.html from the sources
node --check js/screens/<id>.js   # every source file must parse
npm install                 # Playwright only; no runtime deps
npm run smoke               # load every screen in light + dark, apply every state, report console/page errors (exit 1 on error)
npm run shot -- <route> [out.png] [width] [dark]   # screenshot #/<route>, signed in
```

The smoke and shot scripts run against the generated `index.html`, so run `node build.mjs` first. Set `CHROME=/path/to/chromium` to use a different browser build (in cloud sessions: `CHROME=/opt/pw-browsers/chromium`, and don't run `playwright install`). No lint, typecheck or unit test suite exists; the smoke run is the test.

## Architecture

- **Plain HTML/CSS/ES2017 with no build step at runtime.** There are no modules and no libraries. Scripts load as classic `<script>` tags and share the global `App`.
- **`shell.html`** is the source page template. It links `css/app.css`, `js/app.js` and one `<script src="js/screens/<id>.js">` per screen, and it runs as-is from disk for fast iteration.
- **`build.mjs`** reads the `<script src="js/screens/...">` tags from `shell.html` and inlines everything, producing:
  - `index.html`: the whole app in one file
  - `screens/<id>.html`: one page per screen with `App.fileMode = true` and `App.defaultRoute`, so links between screens go file to file
  - `dist/artifact.html`: the same app without the document skeleton (this output is gitignored)

  `index.html` and `screens/*.html` are committed build outputs. Never hand-edit them; edit the sources and rebuild, and commit the regenerated files along with the source changes.
- **`js/app.js`** is the shell. It holds the hash router (`#/<id>?params`), the `NAV` sidebar definition, shared `DATA`, the `UI` helpers (functions that return HTML strings), the command palette (Ctrl K), the prototype map (`?`), the theme, toasts, modals, drawers and the "States" popover. Screens register with `App.register({...})` and own only the inside of `#main`.
- **`js/screens/<id>.js`** holds one IIFE per design board. **`CONTRACT.md` is the authoritative spec for writing a screen module.** Read it before touching a screen. It covers the `ctx` API (`state`, `params`, `rerender`, `on`, `modal`, `confirm`, `drawer`, `navigate`, `toast`), the layout classes and the full list of `UI.*` helpers.
- **Adding a screen** takes three changes: add the module file, add its `<script>` tag to `shell.html` (the build discovers screens from that tag), and add a `NAV` entry in `js/app.js` if it should appear in the sidebar. Then rebuild.

## Rules from CONTRACT.md that are easy to miss

- Screens must not modify `app.js` or `app.css`. Put screen-only CSS in a `<style>` block inside `root`, with selectors prefixed by the screen id.
- Inline styles may use CSS variables only (`var(--fg)`, `--panel`, `--accent`, `--warn-bg`…), never literal colours, so dark theme works.
- Handlers registered with `ctx.on` are dropped on every re-render and route change. Register them inside `render` each time. Keep UI state in `ctx.state` and re-render the whole screen after a change.
- Each board's "States to design from this page" section becomes the screen's `states` array. Each entry needs an `apply` that makes the state visible. Also render the states strip at the bottom of the page with `UI.states(list)`.
- Reproduce the board faithfully and don't invent features, but make every control do something. Primary actions go through confirm → toast → visible change. Copy is plain, with no exclamation marks, emoji or lorem ipsum.
- Escape data with `UI.esc`, and use `type="button"` on buttons.
