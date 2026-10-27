# Plugin UI surfaces: declarative, rendered by the console

1.7.0, Sprint 43, B-11201 (decision D11d, PLG-9). Decided 2026-10-14 by the owner, between the two designs the item names.

## The question

Plugins may add UI to the console. The console runs under a strict content-security policy (`script-src 'self'`,
`frame-ancestors 'none'`, no inline script) and every screen passes axe-core and the reflow checks at 320 and
640 px. How does a plugin's UI appear without weakening either?

## The two designs

| | Sandboxed iframe on a separate origin | Declarative surfaces (chosen) |
| --- | --- | --- |
| What the plugin ships | HTML, script and style, served from a second origin | Data in its manifest: blocks of text, key-value lines, a table, action buttons |
| Who renders it | The plugin's own code in a sandboxed frame | The console, with its own UI helpers |
| Talking to the server | A `postMessage` bridge the console relays | The same bridge, called by the console on the viewer's behalf |
| CSP | `frame-src <plugin origin>` on the console; the plugin origin's own CSP; a second origin to serve and certify | Unchanged |
| Accessibility and reflow | The plugin's markup must pass the checks itself; the console cannot see into the frame | The console's own markup: the same checks as every screen |
| What a plugin can draw | Anything | The block types only |

## Decision

Declarative surfaces. A surface is data, so no plugin code runs in the browser, the content-security policy does not
change, and keyboard use, labels, contrast and reflow come from the console. What is given up is custom drawing: a
plugin that needs a chart or an editor waits for a block type to be added in a reviewed change.

## How it works

- **The manifest** (`ui`, `server/src/plugins/surfaces.ts`) lists up to ten surfaces. Each has an id, a slot, a
  title, the capabilities its bridge may call (a subset of the manifest's), the data calls it reads (`data`) and the
  actions it offers (`actions`), each one of the broker's domain calls (`records.read`, `files.read`, `groups.read`,
  `records.write`, `posts.write`) with its arguments, and its blocks. A manifest whose surface calls something it
  does not declare, or binds context its slot does not give, is refused at install.
- **Slots:** `settings` (a panel on the Plugins and events screen), `record` (beside a record of an app, optionally
  one app and entity), `conversation` (beside a conversation in Chat), `file` (beside a file in Files) and
  `dashboard` (a card on the Overview). A call's arguments may bind `{{context.record}}`, `{{context.app}}`,
  `{{context.entity}}`, `{{context.conversation}}` or `{{context.file}}`, as the slot provides.
- **Approval:** installing grants nothing for a surface. A holder of `plugins:manage` approves each one (all its
  capabilities must be granted), and can disable it, or enable it again, at once. Audited as
  `plugin.surface.approved`, `.unapproved`, `.enabled`, `.disabled`.
- **The bridge** (`POST /api/plugin-surfaces/:plugin/:surface/data|actions/:call`) runs only a call the surface
  declared, by its id, with the slot's context. It runs as the viewer: the plugin must hold the call's capability now
  (a grant taken back after approval refuses it), the viewer must hold the permission the matching route requires,
  and the viewer's clearance is capped at the plugin's max label. The plugin never receives the viewer's session,
  and a surface never reads above the viewer. An action is audited as `plugin.surface.action`.
- **The console** (`GET /api/plugin-surfaces?slot=`) gets the approved, enabled surfaces of enabled plugins for a
  slot, with their blocks and no data, and asks the bridge for each block's data as it draws.

## CSP directives that change

None. The directives in `server/src/http/app.ts` stay as they are: `default-src 'self'`, `script-src 'self'`,
`style-src 'self' 'unsafe-inline'`, `img-src 'self' data:` (plus `MEDIA_ORIGIN`), `media-src`, `font-src 'self'`,
`connect-src 'self'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'self'`, `frame-ancestors 'none'`. No
`frame-src` is added, because nothing is framed.
