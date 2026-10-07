# Accessibility

The console targets **WCAG 2.2 level AA** in its standard mode. People who need more can switch to an **Enhanced
(AAA)** mode that raises contrast and target size and removes motion. This page covers what each mode does, what the
shell does for every screen, how it was checked, and what is still open.

## Modes

Settings → Appearance → **Accessibility** has three choices. The choice is stored with the account
(`PATCH /api/me/preferences`) and applied at every sign-in, so it follows the user to other browsers and devices. A copy
is kept in this browser (`exprsn.a11y` in `localStorage`) so the sign-in screen uses it too. The theme stays per
browser.

| Choice | Effect |
| --- | --- |
| Follow system (default) | Standard, unless the browser reports `prefers-contrast: more`, in which case Enhanced. Changes to the system setting apply straight away. |
| Standard (AA) | The design tokens, adjusted so every text and control pair meets AA (see the measured ratios below). |
| Enhanced (AAA) | Text tokens reach 7:1 on every surface; control borders reach 4.5:1 or more; a 3 px focus ring on every focused element, keyboard or mouse; targets at least 44 × 44 px; links underlined; no animation or transitions; no shadows; toasts stay three times as long. |

`prefers-reduced-motion: reduce` turns animation and transitions off in both modes. Windows high-contrast and other
forced-colour modes keep toggle, selection and meter state visible (`@media (forced-colors: active)`).

The same panel has **Single-key shortcuts**. It is on by default; turning it off disables the `?` key (screen map), so
speech-input users do not trigger it by accident (WCAG 2.1.4). Ctrl K keeps working either way.

How it works: `App.setA11y('aa' | 'aaa' | null)` in `web/js/app.js` sets `data-a11y="aa"` or `"aaa"` on `<html>`;
`web/css/app.css` redefines the colour tokens under `:root[data-a11y="aaa"]` for light and dark, and the Enhanced rules
at the end of the file set targets, focus, links and motion. Screens keep using the same CSS variables and need no
change. The earlier `exprsn.prefs` contrast preference is migrated on first load.

## What the shell does for every screen

- **Skip link** "Skip to main content" as the first tab stop. It moves focus to the screen's heading.
- **Landmarks**: `nav` "Primary" (sidebar), `header`, `nav` "Breadcrumb", one `main` labelled with the screen title,
  and a "Messages" region for toasts.
- **Current page**: `aria-current="page"` on the active sidebar item and on the last breadcrumb.
- **Focus management**: entering a screen moves focus to its `h1` (or to `main` when a screen has no heading). A
  re-render of the same screen puts focus back on the matching control, so keyboard users do not land on `<body>`
  after every action. Off-canvas sidebar links cannot take focus while the menu is closed on narrow screens.
- **Dialogs** (modals, confirms, drawers, the command palette): `role="dialog"`, `aria-modal="true"`, labelled by
  their title; the rest of the page is `inert` while one is open; Tab and Shift+Tab stay inside; Esc closes; focus
  returns to the control that opened it, or to the screen heading if that control no longer exists.
- **Popovers** (workspace switcher, notifications, States): `aria-expanded` on the trigger, focus moves to the first
  item, Esc closes and returns focus to the trigger.
- **Command palette**: an ARIA 1.2 combobox (`role="combobox"`, `aria-controls`, `aria-activedescendant`) over a
  `listbox` of `option`s grouped by heading, with a polite result count.
- **Toasts**: a polite live region; danger toasts are alerts; each toast has a Dismiss button and pauses while hovered
  or focused (WCAG 2.2.1).
- **Forms**: `UI.field` labels the first form control it wraps (keeping an existing id), ties the hint to it with
  `aria-describedby`, and labels non-form controls as a group. Form-control borders use the `--control` token (3:1 or
  more against their background, WCAG 1.4.11).
- **Buttons and tables**: `UI.iconbtn` always has an `aria-label`; an icon-only button a screen builds by hand gets its
  `title` as its name. `UI.table` headers have `scope="col"` (an empty actions header gets hidden text). Clickable
  table rows are focusable and open with Enter or Space.
- **Tabs**: `UI.tabs` renders the ARIA tabs pattern: a `tablist` of `tab` buttons with `aria-selected`, only the
  selected tab in the tab order, Left and Right arrows (wrapping), Home and End moving between tabs with selection
  following focus, and the selected tab labelling one `tabpanel` (`aria-controls`, `aria-labelledby`; set by the
  accessibility pass). Since 1.2.0 (B-1103) the panel holds everything after the list up to the next tab list: when a
  screen renders a tab's content as several siblings, `App.tabPanel` wraps them in one element that repeats the parent's
  flex layout.
- **Reflow** (WCAG 1.4.10, B-1102): at 640 px and below, rows of controls, tab lists and segmented controls wrap, long
  words break, and single-column grids may shrink below their content's width, so no screen scrolls sideways at 320 px
  (400 % zoom) or 640 px (200 %). Tables and code blocks that are wider than the window scroll inside themselves; the
  accessibility pass marks each one `data-scrolls`, makes it a named keyboard stop (`role="region"`, `tabindex="0"`) and
  `app.css` gives it a scrollbar that stays visible.
- **Faint text** (B-1104): `--faint` is for rules and fills only. Text that looks faint (code line numbers, breadcrumb
  separators, step separators) uses `--faint-text`: 4.63:1 or more on every Standard light surface, 4.9:1 or more on
  the dark ones, and the `--muted` values (7:1) in Enhanced.
- **Single-pointer alternatives** (WCAG 2.5.7): a Workflows step moves with the Move buttons in its inspector (20 px a
  press) as well as by dragging, and connects with "Connect from here" then a click on the target; Classifier levels
  have Up and Down buttons as well as drag and drop.
- **Headings**: every screen has an `h1`; in Chat it is the conversation title (or "New conversation") in the header.
- **State**: segmented controls and chips use `aria-pressed`, toggles are
  `role="switch"` with `aria-checked`, classification bars and meter tracks are hidden from assistive technology (the
  level and value are in the text).
- **Target size**: the smallest button (`.btn.xs`) is 24 px high (WCAG 2.5.8).

## Screens made live in 1.5.0 (Sprints 30 to 34)

Each joins the Playwright suite like the others: axe-core and the in-page checker on the screen and every design state
(Standard and Enhanced, light and dark), the screen reflow at 320 and 640 px, and its dialogs and drawers through
`e2e/tests/y-reflow-overlays.spec.ts` (B-3414). What each adds to the shell's behaviour:

- **Moderation** (B-3405): one tab list (Queues, Reports, Appeals, Actions, Sanctions, Providers, Dead letters) with a
  single tabpanel. Selectable queues, flags, appeals and actions are keyboard-operable table rows that update a labelled
  inspector (`aside` "Selected flag" or "Selected appeal"). Filters are named segmented groups; the label chips in the
  queue dialog and the object-type chips in the provider dialog are toggle buttons with `aria-pressed`. Refusals such as
  appeal independence and "already redriven" are problem panels, not colour-only cues. Hide, uphold, deny, lift and
  redrive go through confirm dialogs with labelled note and reason fields, and the step-up dialog for sanctions reports
  errors in a `role="alert"` region. `e2e/tests/moderation.spec.ts` also checks every tab in both modes.
- **Groups and events** (B-3409): the month calendar is a list of day items, each named with its date, "today" and its
  number of events; each event is a button of at least 24 × 24 px named with its title, date, start time and
  "cancelled" where it applies, and the selected one carries `aria-current`. The weekday header row is hidden from
  assistive technology because each day names itself, and the month heading is a polite live region, so Previous and
  Next month announce the new month. The RSVP choice is a labelled group of pressed-state buttons, and the check-in
  toggles in the Attendees drawer are switches named for the person.
- **Channels** (B-3410): a channel's sessions, held replies, settings, email and exports share one tabpanel. Each held
  reply is a panel whose actions are named buttons (Approve, Edit and send, Reject); edit and reject open labelled
  dialogs that return focus to the button that opened them. Transcript messages wrap long text rather than scrolling
  sideways, and each message's report control is an icon button named "Report message N". Live updates over
  `channels.changed` wait while a dialog is open, so an edited reply being typed is never interrupted.
- **Messages and feed** (B-3411): the conversation timeline is a `role="log"` polite live region, so messages that
  arrive over the socket are announced; the typing and read line under it is a separate polite region updated in place,
  without a re-render that would move focus. Message actions stay visible rather than appearing on hover, so keyboard,
  touch and zoom users reach them. The Messages, Feed and People switchers, the conversation filter, the feed sections
  and the search modes are labelled button groups with `aria-pressed`. `e2e/tests/messages.spec.ts` also runs both
  checkers on views with real conversations and posts, which the sweep (as a system admin with none) does not see.
- **Roles and access** (B-3412): both matrices are real tables with a caption for screen readers, `th scope="col"` for
  roles or permissions and `th scope="row"` for permissions or members, each in a `.tablewrap` that scrolls sideways
  only (one named tab stop). Every effective-access cell is a `<button>` named for its subject, permission and outcome
  (for example "Explain Sam Rivera, chat:read: deny at clearance"); the outcome is in the name and an icon as well as
  colour. Enter or a click opens the `explain` drawer with the policy steps in order, and focus returns to the cell when
  it closes. In the role matrix, granted and not-granted cells carry text for screen readers.

- **AT-Protocol** (B-3406, Sprint 31): one tab list (Identity and keys, Labels, Trusted labelers, Firehose, Accounts,
  PDS and feeds) with a single tabpanel; a tab shows only when the user holds its permission (`pki:manage`,
  `labels:manage`, `firehose:manage`, `identity:manage`, `pds:manage`), and the sidebar entry needs any one of them.
  Labelers and subscriptions are keyboard-operable table rows that update a labelled inspector (`aside` "Selected
  labeler" or "Selected subscription"). Long DIDs, keys and at:// URIs wrap instead of scrolling sideways; the DID
  document is a named code region. Errors from the server (refused DIDs, endpoints, handles, feed rules) are problem
  panels in a `role="alert"` region of the dialog, and the hosting switch's step-up dialog reports errors the same way.
  The account check writes its steps into a polite live region. `e2e/tests/atproto.spec.ts` also runs both checkers
  on every tab and on the invite-code drawer, in light and dark, with the data it made (a rotated key, a hosted
  account, a published feed), which the sweep's design states do not all reach. With it the sweeps cover 36 sidebar
  screens and Settings.
- **Workflows** (B-3910, Sprint 32): the live screen gained the Workflows 2 step kinds, so its step palette is longer
  than the reflow sweep's 25 controls; the palette's buttons only add a step to the draft, so the sweep skips them and
  reaches the controls that open dialogs and drawers.
- **Settings: app passwords for DAV clients** (B-3415, Sprint 32): the devices are a table whose Revoke buttons are
  named for the device ("Revoke the app password for iPad") and go through a confirm dialog. The create dialog
  focuses the device name, groups the CalDAV, CardDAV and WebDAV choices in a `fieldset` with a legend (a scope the
  caller's roles do not allow is disabled and says so in its label), and reports a missing name or scope in a
  `role="alert"` region. The step-up dialog, in its factor-only mode, asks for an authenticator code or a passkey
  before the password is made; the new password is shown once in a notice with a Copy button, never in a toast.
  `e2e/tests/settings.spec.ts` drives it end to end.
- **Settings: public profile and status** (B-5801, B-5802, Sprint 34): pronouns, label, bio and "Shown in" are labelled
  fields with their limits in the hint; the picture's file input is named "Profile picture" and opened from a button,
  the initials that stand in for a missing picture are hidden from assistive technology, and a guardrail refusal shows
  as a problem panel. The status choice is a labelled segmented group ("Status") and what others see is written out
  beside it, not only coloured.
- **Person** (B-5801, B-5802, Sprint 34, the profile page opened from people's names on Messages, the feed and
  Groups): the directory is a labelled search ("Search people") over a keyboard-operable list, the person's name is the
  page's `h1`, and the picture has an `alt` naming the person (the initials fallback is `aria-hidden`). Status is a
  pill with its word, never colour alone, and a name-only view says why in a notice. Block goes through a confirm
  dialog. The page joins the screen sweeps (`e2e/tests/support/sweep.ts`, opened as a system admin), and
  `e2e/tests/person.spec.ts` runs both checkers in Standard and Enhanced on a filled-in profile.
- **Runs chain tree and registry chaining fields** (B-4108, B-4109, Sprint 34): the chain tree in Runs is a
  labelled nested list ("Chain tree") of buttons, one per invocation, reached with Tab and opened with Enter, whose
  text names the node; a held call shows its path and is approved or rejected from the root run. The registry editor's delegates,
  workflows and skill-dependency fields are labelled lists, and the "used by" view is a dialog that says in text why
  Retire or Delete is unavailable. `e2e/tests/runs-chain.spec.ts` runs axe-core and the in-page checker on the tree in
  light and dark and the reflow check at 320 and 640 px.

## Screens changed in 1.6.0

- **Models: model servers and server-held models** (B-4307, Sprint 35a): Model servers is a drawer of one panel per
  Chat Completions server, its health a pill with its word (healthy, unreachable), never colour alone, and an
  unreachable server says so in a notice; Probe again is disabled with a reason (`title`) while the server does not
  answer. Register model server is a labelled form: the kind, the transport, the socket path or URL and the bearer
  token (a password field with `autocomplete="off"`) are each labelled with a hint; choosing Ollama or a URL hides the
  fields that no longer apply with `hidden`, so they leave the tab order and the accessibility tree. Request import has
  a named segmented group ("Where the model comes from", pressed-state buttons) that swaps the form inside the same
  dialog, so focus stays in it. The server-held models are a `fieldset` with a legend ("Models the servers hold") of
  radio buttons; a model the server reports unavailable (Apple's Private Cloud Compute), already catalogued or on a
  server that is not answering is a disabled radio whose label says why in text. A held model's inspector and card
  say "held by the server, no digest" and list what the server reported in words. `e2e/tests/models.spec.ts` runs
  axe-core and the in-page checker on the register form, the drawer and the picker and checks each at 320 px; the
  new design state ("Server model unavailable") is in the sweeps of `y-accessibility.spec.ts` and
  `y-reflow-overlays.spec.ts`.
- **Storage: deduplication** (B-4601, Sprint 36b): Usage gains a fourth button in its pressed-state segmented group,
  Deduplication. It shows four stat tiles (saved, stored, held by versions, shared objects), each a number with its
  word, and a table of tenants whose meter carries its percentage as text; an empty table names why ("Nothing shared
  yet"). A sentence under the table says in words that content is never shared across tenants and that quotas count
  every version. `storage-configuration.spec.ts` checks the view, its new design state ("Nothing shared yet") in
  light and dark with axe-core and the in-page checker, and its reflow at 320 and 640 px.
- **Moderation: held form submissions** (B-4701, Sprint 36b): selecting a hold flag on a public form submission shows
  the submitted values in the inspector as a key and value list, the held fields marked with a "held" pill (a word,
  not a colour), the rule and reason in text, and two named buttons, Accept into a record and Reject, each through a
  confirm dialog with a labelled optional reason. A refusal by the entity is a danger notice in the inspector naming
  the reason, so it is read without the toast. The two new design states are in the `y-accessibility.spec.ts` sweep;
  `moderation.spec.ts` accepts a held submission from the queue.
- **Vault: reveal flags** (B-4803, Sprint 36b): a fifth tab, Reveal flags, in the same tab list. A pressed-state
  segmented group filters by state; each row's signals are pills with words (new address, odd hour, burst) and the
  state a pill with its word. The inspector lists the signals as a timeline with their details in text and the recent
  reveals as a table; Expected and Suspicious open a dialog with a labelled note field. A suspicious flag keeps a
  notice that says to rotate the secret, with a button to open it. A notification about an unusual reveal links
  straight to the flag (`#/vault?tab=flags&flag=<id>`). The two new design states are in the `y-accessibility.spec.ts`
  sweep; `vault.spec.ts` resolves a flag raised by a burst from a new address and checks the tab's reflow at 320 and
  640 px.

- **Knowledge: image documents; Classifiers: the vision engine** (B-8804, Sprint 36c): an image document's thumbnail
  carries its caption as alt text, or "Image: <document name>" until it has one; the alt is never empty, even where
  the caption is shown beside it. The label filter chips are buttons with `aria-pressed` and their document counts in
  text. Label scores are numbers with the threshold state in words ("above threshold", "below threshold"), never by
  colour alone. The image document drawer keeps the description in text: the caption, and the image's text as a
  labelled block, so nothing is only in the picture. The vision profile and the image classifiers are
  labelled controls in the base's Image settings dialog (the classifiers in a fieldset with a legend), and a disabled
  classifier says why in its label (a draft); Re-classify is a labelled button beside the chips and in the image
  drawer. The Classifiers screen offers `vision` in the engine select of New classifier, and a vision
  classifier's test dialog takes an image file through a labelled file input. `e2e/tests/knowledge-images.spec.ts` runs
  axe-core and the in-page checker on the image documents, the drawer, the filter chips and the settings dialog, and
  checks each for sideways scrolling at 320 and 640 px.

- **Groups and Social and messaging: groups depth** (B-4401 to B-4405, Sprint 36a): the Groups list's mode switch
  (My groups, Discover, Trending) is a named segmented group of pressed-state buttons; Category is a menu button like
  the other filters, and Distance opens a labelled dialog (a select of known places, the point and the radius, each a
  labelled field with a hint). An active filter says so in its button text ("Within 50 km") and its accessible name
  names the centre. Discover and Trending say what ranks the list in text above it; each row's second line says why
  (shared members and activity, or joins and posts) and the distance in km, in words, never by colour. The Channels
  tab is a table whose rows open the channel with a click or Enter (`tabindex="0"`, an accessible name "Open the
  channel …"); a channel's page names its group with a link back. New channel is a labelled form whose label select
  offers the labels up to the caller's clearance, preset to the group's, with a hint naming the floor; a label below it
  is refused by the server and shown as a problem panel with the server's words. Group settings add Category, Place and "Latitude, longitude" fields with hints. On
  Social and messaging, Group categories and Trending groups are tables with column headers; Rename and Remove carry
  the category's name in their accessible names, and New category is a labelled dialog whose errors land in a
  `role="alert"` region. `e2e/tests/groups-depth.spec.ts` runs axe-core (Standard and Enhanced) and the in-page
  checker in light and dark on Discover, Trending, the Channels tab, a channel, the Social and messaging Groups tab,
  the New channel, Distance filter and New category dialogs and the six new design states, and checks each at 320
  and 640 px; `e2e/tests/social.spec.ts` sweeps the Social and messaging states (now six).

- **Registry: HTTP tools and allowed hosts** (B-8904, Sprint 37a): the entry form's Kind select offers Tool (HTTP
  request), which swaps the fields inside the same dialog so focus stays in it. Every HTTP field is labelled with a
  hint (method, URL template, input schema, query parameters, headers, body, response mapping, cap and timeout); the
  side-effect select is disabled for GET with the reason in its hint; the vault reference picker is a labelled select
  of the paths the caller may read, a labelled key field and an Insert button that writes the reference into the
  headers field, so nothing is picked by pointer alone. "Fill from the URL" fills the input schema from the URL's
  placeholders. A refused save (a literal credential) is a problem panel with the server's words in the inspector, not
  only a toast. The inspector's HTTP rows (request, parameters, headers, response, calls in the last day, the outbound
  guard) are text in the key and value list. Allowed hosts is a drawer with a labelled host field, an Add button and a
  Remove button per host whose accessible name names the host; changes are announced by toast and stay visible in the
  list. `e2e/tests/registry-http.spec.ts` creates, tests and publishes an HTTP tool from the console and keeps the
  allowed hosts; `y-accessibility.spec.ts`, `y-reflow.spec.ts` and `y-reflow-overlays.spec.ts` (with
  `E2E_ONLY=registry,guardrails,profiles`) found nothing on the screen, its two new design states (HTTP host refused,
  Literal credential refused), the form and the drawer, Standard and Enhanced, light and dark, at 320 and 640 px.
- **Guardrails: the untrusted-content checkpoint** (B-6902, Sprint 37a): a twelfth checkpoint in the list. Its
  Prompt-injection defence panel states the mode as a pill with its word (annotate, block, off) and a sentence saying
  what it does; detections by source and the recent detections are tables with column headers, actions as pills with
  words (annotated, blocked), scores as numbers; the CI corpus rates are a sentence. Add a blocking rule is a button
  that is disabled with its reason (`title`) where it does not apply (the platform baseline, a set that already has
  it) and goes through a confirm dialog. The rule editor's injection mechanism has a labelled engine select and a
  threshold or guard profile field with hints. The review bar wraps at narrow widths (it scrolled sideways at 320 px
  when a draft had all four buttons). The new design state (Poisoned page blocked) is in the sweeps.
- **Profiles: trust marking** (B-6901, Sprint 37a): a labelled check box, "Mark retrieved and tool text as data",
  under the field label Untrusted content with a hint saying what it does; the save dialog names the change in words
  ("Untrusted content marking: on → off") and the saved YAML shows `trustMarking`. `e2e/tests/profiles.spec.ts`
  switches it off as a new version.

- **Identity: MCP server; Settings: MCP access; MCP servers: OAuth for users** (B-7101 to B-7103, Sprint 37b): the
  Identity tab list gains MCP server with its published count in text. Each workspace is a table row whose state is a
  word ("published", "off"), never only a colour; Edit and the copy button carry the workspace's name in their
  accessible names ("Edit the MCP server of Finance Ops", "Copy the URL of Finance Ops"). The edit drawer is a labelled
  form: Published and Require DPoP-bound tokens are switches (`role="switch"`, `aria-checked`), the tool groups are
  checkboxes in a fieldset with a legend, each saying what the group publishes, and the label select has a hint naming
  the workspace ceiling; the preview below it is a table that updates as groups change. Self-registration is a switch
  whose state is repeated in text (the registration endpoint, or "not offered"), and turning it on asks for
  confirmation in a dialog. In Settings, MCP access is one panel of tables with column headers: the connection URLs
  (copy buttons named per workspace), the calls waiting for approval (Approve and Reject named with the tool, the side
  effect as a word, the arguments in text, and the approval dialog repeating them in a code block), and the MCP servers
  that act as you (the connection as words, Connect and Disconnect named per server; Connect opens a dialog that says
  where the browser will go before it leaves). On MCP servers, OAuth for users is a key-value list with Discover, Enter
  by hand and Remove buttons; discovery reports each step in a table with the result in words; Enter OAuth by hand is
  a dialog of labelled fields with hints. Identity's PKCE switch for a public client, which cannot be changed, is now
  `aria-disabled` (the toast still explains why). `e2e/tests/mcp-server.spec.ts` runs axe-core (Standard and Enhanced)
  and the in-page checker in light and dark on the MCP server tab and its drawer, MCP access and its approval dialog,
  the Connect dialog, the OAuth panel, the discovery result and the manual dialog, and checks each for sideways
  scrolling at 320 and 640 px; the new design states (three on Identity, two on Settings, one on MCP servers) are in
  the `y-accessibility.spec.ts` sweep.

## Screens made live in 1.6.0 (Sprint 35, B-4207)

The platform administration screens join the same checks: axe-core and the in-page checker on the screen and every
design state (Standard and Enhanced, light and dark), the reflow check at 320 and 640 px, and their dialogs and
drawers. Each one's own spec also runs those checks on each tab and dialog, so the screen is checked without the full
suite.

- **Social and messaging** (B-4206, `e2e/tests/social.spec.ts`): five tabs (Feed, Groups and events, Messaging,
  Realtime for platform admins, Relations) in one tabpanel. Every policy control in a table is named for its
  workspace (`Approver for Finance Ops`, `Default join mode for Legal`, `Contact rule for Field Sales`); the switches
  for "Posts pass user-input" and "Media" are `role="switch"` buttons read with their column header, and those the
  caller may not change are disabled, with the reason in the notice under the table. Exclude, Include, Revoke and
  Apply buttons in repeated rows carry an accessible name naming the tag, feed or workspace. Groups are
  keyboard-operable rows that fill a labelled inspector ("Selected group"). The realtime sparklines are decorative
  (`aria-hidden`), with the current count beside each in text. Transfer ownership, Close a user's rooms and the
  confirms are dialogs that return focus; the export drawer reports a missing reason or a refusal in a
  `role="alert"` region, and the step-up check for exports asks in a dialog like the one for sanctions. Long ids,
  hashtags and reasons wrap rather than scroll sideways; the wide policy tables scroll inside their named table
  region. The spec checks each tab, the Transfer ownership and Close rooms dialogs, the export drawer and every
  design state.
- **Tenants, Create from template** (B-4501, `e2e/tests/tenants-templates.spec.ts`): the template picker is a group of
  radio cards, each a label for its radio with what the template creates; the enrolment link is shown once in a
  dialog with a Copy button. Both dialogs pass the checks above.

- **Overview** (B-4202, B-4207, Sprint 35b): the page's sections are `h2` headings (Alerts, the counters' window,
  Instances); each alert is a notice whose tone is also its words (the title says what is wrong), with an Open and an
  Acknowledge button whose name includes the alert's title. The window is a labelled segmented group ("Counters
  window") with `aria-pressed`; the Open flags and Held replies counters are buttons. Instance state, schema and the
  `/readyz` checks are pills with their word, never colour alone; the instances table is a named sideways scroller at
  narrow widths and the inspector stacks under it. Drain and Acknowledge go through confirm dialogs; a drain that needs a
  recent sign-in opens the labelled step-up dialog, whose error is announced (`role="alert"`). The page refreshes at
  the heartbeat's pace and does not re-render while a dialog is open.
- **Jobs and queues** (B-4203, B-4207, Sprint 35b): the five tabs are the ARIA tabs pattern with one tab panel; the
  filters are labelled selects (Domain, Tenant, State, Type) and labelled searches; the window is a labelled
  segmented group. Row actions name their row (for example "Invalidate plugins", "Redrive job …"). Pause, cancel and
  discard ask for a reason in a dialog whose field is labelled ("Reason", or "Reason (optional)") and whose refusal is
  announced; job states are pills with their word and progress meters carry their percentage as text.

Both screens join the screen sweeps (`e2e/tests/support/sweep.ts`). `e2e/tests/overview.spec.ts` and
`e2e/tests/jobs.spec.ts` run the in-page checker and axe-core in Standard and Enhanced, light and dark, on the screen,
every tab and every design state, and the reflow check at 320 and 640 px on every tab and on the drain and pause
dialogs.

- **Storage** (B-4204, Sprint 35c): one tab list (Stores, Usage, Quarantine, Integrity, Purges) with a single
  tabpanel. Stores, workspaces and quarantined objects are keyboard-operable table rows that update a labelled
  inspector (`aside` "Details"); each store's settings are buttons that open Configuration on that setting. Health,
  quarantine states and findings are pills with their word, and the quota and capacity meters carry their numbers in
  text beside the bar. The quarantine state filter is a menu of `menuitemradio` buttons with `aria-checked`. Every
  destructive action (deleting from quarantine, deleting orphans, retiring the old store) goes through a dialog whose
  reason field is labelled and reports a missing reason in a `role="alert"` region; the dry run's result is a notice
  on the page as well as a toast, so it does not vanish before it is read. The migration dialog's step-up check and its
  server refusals (an unreachable target, a refused endpoint) are problem panels in the same kind of region. Wide
  tables (stores, usage, findings, purges) scroll sideways inside their named `.tablewrap`; long keys and paths wrap.
  `e2e/tests/storage-configuration.spec.ts` deletes an orphan found by the integrity check after a dry run, and runs
  both checkers on all five tabs and five design states.
- **Configuration** (B-4205, Sprint 35c): the section list is a labelled navigation region whose current section
  carries `aria-current`; the filter chips are toggle buttons with `aria-pressed`, and so is Compare instances.
  Settings are keyboard-operable rows (365 of them) that update a labelled inspector (`aside` "Setting details").
  Whether instances differ, a value is deprecated or an override is pending is said in a pill with its word, not only
  in colour; compared values are highlighted and also marked "differs". Secrets are text ("set, 44 characters, from
  file …"), never a masked field. The override drawer labels its value and reason fields, and a value the server
  refuses (`422`) shows as a problem panel with the schema's message in a `role="alert"` region. The spec proposes an
  override as one platform admin and approves it as another in a second browser.


## How it was checked

- **Contrast** of every token pair the console uses, computed with the WCAG relative-luminance formula from the values
  in `web/css/app.css`. Targets: 4.5:1 for text in Standard, 7:1 in Enhanced, 3:1 for non-text (control borders, focus
  ring, meter fill). All pairs pass. Minimum over the surfaces `--bg`, `--nav`, `--panel`, `--panel2` and `--sel`:

| Pair | AA light | AA dark | AAA light | AAA dark |
| --- | --- | --- | --- | --- |
| `--fg` on surfaces | 14.59 | 13.15 | 15.83 | 14.11 |
| `--fg2` on surfaces | 7.01 | 8.03 | 9.00 | 10.18 |
| `--muted` on surfaces | 4.85 | 5.48 | 7.47 | 8.03 |
| `--accent` on surfaces | 5.01 | 6.14 | 7.28 | 7.73 |
| `--danger-fg` on surfaces | 6.53 | 6.34 | 7.62 | 7.81 |
| `--warn-fg` on surfaces | 5.80 | 8.24 | 7.92 | 9.31 |
| `--info-fg` on surfaces | 7.15 | 7.28 | 8.39 | 8.20 |
| `--ok-fg` on surfaces | 5.55 | 7.86 | 7.75 | 8.88 |
| `--accent` on `--accent-tint` | 5.15 | 6.19 | 7.49 | 7.80 |
| `--muted` on `--accent-tint` (selected row) | 4.98 | 5.53 | 7.68 | 8.10 |
| `--accent-fg` on `--accent` (primary button) | 5.98 | 7.71 | 8.70 | 9.71 |
| `--bg` on `--fg` (toast) | 15.69 | 16.26 | 17.02 | 17.45 |
| `--warn-fg` on `--warn-bg` | 6.16 | 7.96 | 8.42 | 9.00 |
| `--danger-fg` on `--danger-bg` | 6.56 | 6.73 | 7.65 | 8.29 |
| `--info-fg` on `--info-bg` | 7.30 | 6.96 | 8.56 | 7.83 |
| `--ok-fg` on `--ok-bg` | 5.76 | 7.44 | 8.04 | 8.40 |
| `--fg2` on `--bubble` (chat) | 7.01 | 6.91 | 9.00 | 8.76 |
| `--control` (field borders) on surfaces | 3.58 | 3.72 | 6.06 | 6.09 |
| `--focus` (focus ring) on surfaces | 5.01 | 6.14 | 15.83 | 14.11 |
| `--meter` (meter fill) on `--sel` | 3.33 | 4.36 | 4.85 | 6.12 |

  Before this work, field borders used `--line` (1.37:1 light, 1.32:1 dark) and the meter fill was 2.72:1 on its
  track; both are now above 3:1.

- **axe-core 4** (tags `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`, plus `wcag2aaa` in Enhanced) on
  sign-in and every signed-in screen (36 since Sprint 30), in Standard and Enhanced, light and dark, against the e2e server's seeded data.
  No violations remain; the last findings fixed were low-contrast helper text on Classifiers, an unfocusable scrolling
  YAML block on Profiles, and toggles that picked up the browser's grey button background in dark mode.
- **In CI** since 1.2.0 (B-1101, B-1102): the Playwright suite checks every screen, each of its design states (applied
  through `App.applyState`, which also opens the drawers and dialogs the boards describe; the console no longer shows a
  control for them), the sign-in screen and a streaming
  chat answer, in light and dark, and fails on any finding (`e2e/tests/y-accessibility.spec.ts`). It uses an in-page
  checker (`e2e/tests/support/a11y.ts`) modelled on axe-core's WCAG A/AA rules: contrast with alpha and opacity, names,
  roles and ARIA references, required parents and children, one tab panel per tab list, aria-hidden focus, scrolling
  regions, nested controls, lists, language and title. `e2e/tests/y-reflow.spec.ts` checks every screen for
  two-dimensional scrolling at 320 and 640 px. Fixed on the way: faint text below 4.5:1 (B-1104), nested buttons in
  Pools rows, the Media caption contrast, and tab content outside its panel (B-1103).
- **axe-core in CI** since 1.3.0 (B-1506): `axe-core` (pinned in `e2e/package.json`) runs on the same page loads as the
  in-page checker, on every screen and design state, sign-in and the streaming chat, in light and dark, and in both
  modes: Standard with the WCAG 2.0, 2.1 and 2.2 A and AA rules, then Enhanced (switched in place with
  `App.setA11y('aaa')`, so it costs no extra navigation or API requests) with the same rules plus AAA contrast
  (`color-contrast-enhanced`: 7:1, 4.5:1 for large text). Any violation fails the suite (`e2e/tests/support/axe.ts`).
  Fixed on the way: a field-hint link on Profiles below the 24 px target size (WCAG 2.5.8) and the unlabelled workflow
  picker on Workflows (`select-name`).
- **Dialogs and drawers** (B-1507): `e2e/tests/y-reflow-overlays.spec.ts` opens each screen's dialogs and drawers at
  320 px (400 % zoom) and 640 px (200 %), through its design states and then through its own controls until it has
  shown a dialog and a drawer (unsafe API calls are answered by the test, so nothing changes on the server), and fails
  when the page, the overlay or the dialog scrolls sideways or anything in it sticks out past its edge, other than
  tables and code in a named scroller. Fixed on the way: at 640 px and below a long breadcrumb with its label (a
  connection's) overlapped the header tools and pushed the page 2 px sideways; the breadcrumb now shrinks and clips.
- **Sprint 30 and 31 screens** (B-3414): Certificates, Vault, Plugins and events, AT-Protocol (Sprint 31), Apps and Files, and the identity additions
  on Identity, User stores, Settings and Sign in, joined the sweeps above (every design state, Standard and Enhanced,
  light and dark, reflow at 320 and 640 px for the screens and their dialogs and drawers). Each opens a dialog from its
  own controls (New profile, Add grant, Upload, New folder, the Grants dialog…), Vault and Plugins also a drawer.
  Fixed on the way: stacked checkboxes (plugin grants, sign-up, MFA and invitation roles) and inline tag links in Files
  were below the 24 px target size (WCAG 2.5.8) and now have 24 px rows or 12 px gaps; the remove control of a state or
  filter chip in Apps is its own labelled icon button rather than a clickable span; Apps' records grid and form rows
  are focusable and select with Enter or Space; Apps' state diagram scales to the width instead of scrolling sideways
  and carries a text alternative; the Plugins catalogue and the Vault engine inspector no longer stick out at 320 px;
  Apps re-renders after a `change` only once focus has moved on, and keeps it where it went; Certificates' issue dialog
  redraws its form when the mode or profile changes while keeping the values entered and the focus. Vault's secret and
  password copy buttons copy without echoing the value in a toast.
- **Keyboard walk** in Chromium: skip link, landmarks, `aria-current`, focus on screen change, palette combobox and
  arrows, dialog labelling, focus trap in both directions, Esc and focus return, header re-render keeping focus,
  popover focus and Esc, focusable table rows, focus kept on re-render, persistence across reload, system contrast and
  reduced-motion preferences, and the narrow-screen menu. All checks pass.

## Known gaps

Sprint 17 closed the gaps listed for 1.1.0: tab panels (B-1103), reflow (B-1102) and faint-text contrast (B-1104) are
described above, and the checks now run in CI (B-1101). Sprint 23 put axe-core in CI in both modes (B-1506) and
measured dialogs and drawers for reflow (B-1507). These remain:

- axe-core leaves some results as "needs review" (for example contrast over background images or gradients, and text
  under overlapping elements); those do not fail the suite and are not reviewed automatically.
- The dialog and drawer reflow check reaches each screen's dialogs through its design states and its own controls; a
  dialog that only opens after a server-side change (for example a step that follows a successful save) is not
  measured, since the check answers every unsafe API call itself.
- No screen-reader session (NVDA, JAWS, VoiceOver) has been recorded yet; the checks above are automated or keyboard
  only.
