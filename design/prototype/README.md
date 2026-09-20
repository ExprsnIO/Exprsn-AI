# Exprsn-AI console — clickable prototype

A single-page, click-through prototype of the Exprsn-AI console, built from the design boards in `exprsn-ai-design-dc` and the *Platform Architecture & Delivery Plan*. It is plain HTML, CSS and JavaScript with no build step, so it opens straight from disk and runs inside the air gap.

## Run it

- Open `index.html` in a browser, or
- `node build.mjs` and open `dist/index.html` (everything inlined into one file, handy for sharing).

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
index.html          shell markup, loads every screen
css/app.css         design tokens (light + dark) and shared components
js/app.js           router, sidebar, header, palette, toasts, modals, UI helpers
js/screens/*.js     one module per board (see CONTRACT.md for the module contract)
build.mjs           bundles into dist/index.html
shot.mjs            Playwright screenshot helper used while building
CONTRACT.md         how a screen module is written
```

Screens: sign-in, chat, compare, runs, knowledge, memory, media, images, models, profiles, pools, training, registry, MCP servers, workflows, scripts, connections, guardrails, flags, classifiers, usage and audit, tenants, identity, zones, platform, settings, plus the shared-components sheet.

Everything shown is example data for the Northwind tenant. Nothing is persisted beyond the browser tab except the theme choice and the signed-in flag.
