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
  sign-in and all 26 signed-in screens, in Standard and Enhanced, light and dark, against the e2e server's seeded data.
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
