# Console end-to-end suite

Playwright specs that drive the console in `web/` against the real server, one spec per sidebar screen plus sign-in,
"not permitted" and Settings. Nothing is mocked in the browser: every click goes through the API, the job workers,
Socket.io and the gateway. The external workers are the fakes the unit tests use (`server/test/`): Ollama, the MCP
server, the script sandbox, ffmpeg, the image worker and safety classifier, the GPU trainer and the ACME directory.

## What runs

`global-setup.ts` starts `server.ts` in a child process (`node --import tsx`). It builds the services on a temporary
SQLite file with generated secrets, runs the migrations and the bootstrap, starts the fakes, seeds a pool on the fake
Ollama with four approved models and two published profiles, a workspace, a flag in the review queue and a JSON Lines
file in the training staging area, creates the accounts below, and serves `web/` on a free port. It writes
`.state/server.json` (URL, accounts, TOTP secrets) and is stopped when the run ends.

| Account | Roles | How it signs in (`tests/auth.setup.ts`) |
| --- | --- | --- |
| `root` | system admin | password and a pre-enrolled authenticator (the second-factor step) |
| `ops` | system admin | the same; spare admin |
| `root2` | system admin | first sign-in enrols an authenticator; the second person for dual control |
| `mladmin` | ML admin, member | first sign-in enrols an authenticator |
| `member` | member | password only |
| `enrol` | model admin, member | enrols inside the Settings spec, which also signs it out |

The setup project signs each account in through the sign-in screen once and keeps the session cookie; the specs reuse
it (`test.use({ user: 'member' })`, and `as('root2')` for a second browser in the same test).

Every test fails when the page logs a console error, throws, or gets a failed or 4xx/5xx response it did not declare
(`watch.allow.push(/…/)`), see `tests/support/fixtures.ts`. `a-first-look.spec.ts` opens every screen in light and
dark on the fresh server (mostly empty states); `zz-every-screen.spec.ts` does it again at the end, when the screens
hold what the other specs created. Both check that the sidebar lists every screen and that none shows the
"Prototype data" banner. Tests run in one worker, in file order, against one server.

## Run it locally

From the repository root, with the workspace installed (`npm ci`) and Node 22:

```sh
cd e2e
npm ci
npx playwright install chromium     # once, on a machine without a Playwright browser
npx playwright test                  # about two minutes
npx playwright test chat zones       # some specs (the setup project always runs first)
npx playwright show-report           # the HTML report, with traces of failed tests
```

`E2E_SCREENSHOTS=1` saves a light and a dark screenshot of every screen under `test-results/` (not committed).
`E2E_SERVER_LOG=1` echoes the server's output; `E2E_LOG_LEVEL=info` makes it chattier. `E2E_ENV_<NAME>=value` passes
`<NAME>=value` to the server's configuration.

To keep a server up while writing a spec, start it yourself and point the suite at it (the state file is the same):

```sh
node --import tsx e2e/server.ts      # from the repository root; prints E2E_READY <url>
E2E_URL=1 npx playwright test        # in e2e/, reuses the running server
```

## In cloud sessions

The browser is preinstalled; do not run `playwright install`:

```sh
cd e2e && npm ci && CHROME=/opt/pw-browsers/chromium npx playwright test
```

`playwright.config.ts` uses `CHROME` as the Chromium executable when it is set.

## CI

The "Console end-to-end (Playwright)" job in `.github/workflows/ci.yml` installs the workspace and this package,
installs Chromium with its system dependencies, runs the suite with one retry, and uploads `playwright-report/` and
`test-results/` (traces, screenshots) when it fails.

## Writing a spec

- Open a screen with `open(page, 'route')`; it waits for the router and for "Loading…" to go.
- Prefer the screens' `data-*` hooks and visible copy over CSS structure; the console has no build step and the
  markup is plain strings.
- Seed only what the screen under test cannot create itself, through `apiAs(user)` (the API with that account's
  session) or in `server.ts`; the step under test goes through the console.
- A test may run after any other spec, so do not depend on another spec's data; name things uniquely.
