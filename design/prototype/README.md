# Exprsn-AI console — clickable prototype

A single-page, click-through prototype of the Exprsn-AI console, built from the design boards in `exprsn-ai-design-dc` and the *Platform Architecture & Delivery Plan*. It is plain HTML, CSS and JavaScript with no build step, so it opens straight from disk and runs inside the air gap.

## Run it

Open `index.html` in a browser. It is one self-contained file with the CSS and every screen embedded; nothing to install or build.

Each screen is also available on its own under `screens/` (for example `screens/models.html`). Those pages are self-contained too, and links between them go from page to page.

Sign in with any password. You land as **Mara Okafor**, a Finance Ops member who also holds admin roles, so every console area is visible.

## Getting around

| Action | How |
| --- | --- |
| Go anywhere | Sidebar, or `Ctrl K` for the command palette |
| See every screen | Press `?` for the prototype map |
| Show a board's design states | **States** button in the header (each board's "States to design from this page" section is wired up) |
| Theme | Sun/moon button in the header; follows the system by default |
| Narrow layout | Resize below 900px; the sidebar becomes a drawer |

## Layout

```
index.html          the application, generated: CSS and all screens embedded
screens/<id>.html   one generated page per screen, same shell, file-to-file links
shell.html          the page template the generator starts from (also runs as-is against css/ and js/)
css/app.css         design tokens (light + dark) and shared components
js/app.js           router, sidebar, header, palette, toasts, modals, UI helpers
js/screens/*.js     one module per board (see CONTRACT.md for the module contract)
build.mjs           regenerates index.html and screens/ from the sources
shot.mjs, smoke.mjs Playwright helpers used while building (need `npm i playwright`)
CONTRACT.md         how a screen module is written
```

To change a screen, edit its file under `js/screens/` (or `css/app.css`, `js/app.js`) and run `node build.mjs` to regenerate `index.html` and `screens/`. Opening `shell.html` runs the sources directly without regenerating.

Screens: sign-in, chat, compare, runs, knowledge, memory, media, images, models, profiles, pools, training, registry, MCP servers, workflows, scripts, connections, guardrails, flags, classifiers, usage and audit, tenants, identity, zones, platform, settings, plus the shared-components sheet.

Everything shown is example data for the Northwind tenant. Nothing is persisted beyond the browser tab except the theme choice and the signed-in flag.
