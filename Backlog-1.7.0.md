# Backlog: 1.7.0

The work after 1.6.0. On 2026-10-05 the owner moved 1.5.0's Sprint 33 here: agents, tools and skills in chat (B-40)
and the second half of the model and dataset import wizard (B-38: datasets, knowledge sets, classifier eval sets and
the Import screen). 1.5.0 keeps what these build on: Workflows 2's agent step and skill loading (B-3902) and built-in
domain tools (B-3904), the chain context (B-4101) and the rest of chaining (B-4102 to B-4109), and the repository
registry, browse and model import (B-3801 to B-3803). Rules as before: everything follows `docs/PLAN.md` and
`CLAUDE.md`; screens follow `design/prototype/CONTRACT.md` (prototype board first, then live when every control is
backed by the server); every server item ships its routes, permission, audit events, jobs, tests on SQLite,
PostgreSQL and MySQL, `docs/api.md` and `docs/openapi.json` entries and any known gaps in `docs/security.md`.

**Size.** 13 items, 72 points (1 point ≈ half a day for one engineer, tests included): P1 72. About one sprint of
work at 78 points a sprint; it is numbered Sprint 38 so the 1.6.0 sprints (35 to 37) keep their numbers.

**Builds on.** B-39 Workflows 2 and B-41 chaining (1.5.0), the registry dispatcher and the tool-call guardrail, agent
runs and their budgets, the B-3801 repository registry and B-3803 model import, the 500 GB dataset quota and the
`legal-review` licence exceptions decided on 2026-10-05.

## Sprints

| Sprint | Theme | Items | Points | Status |
| --- | --- | --- | --- | --- |
| 38 | Agents, tools and skills in chat; dataset import, knowledge sets and the Import screen; release | B-4001–B-4009, B-3804–B-3807, B-5901 | 72 | Planned |

The order follows the dependencies: what a conversation may call (B-4001) before any call from chat (B-4002 to
B-4006); the Chat board (B-4007) before the live screen (B-4008); dataset import (B-3804) before knowledge sets and
eval sets (B-3805, B-3806), and all of them before the Import screen (B-3807) goes live, which also gives 1.5.0's
model import its screen.

---

## P1

### B-40 Agents, tools and skills in chat (43 points)

Added 2026-10-05 at the owner's request. Chat today offers only the tools on its profile's list, read-only ones whose
`confirm` is `never`, and only when the model decides to call them; write and destructive tools are left out because
their approval exists only in agent runs; agents run only from the Runs screen; skills reach a model only through an
agent's definition. This epic lets a person call each of them from a conversation, and reuses what already decides
them: the registry's publish and label rules, the dispatcher with the tool-call guardrail and its approvals, agent runs
with their budgets, and skill instructions as agents load them (and as model steps will, B-3902). Every invocation is
audited, metered to the conversation, sealed with the tenant key and labelled at the higher of the conversation's and
the entry's label; nothing runs above the conversation's ceiling or the caller's clearance.

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-4001 | What a conversation may call: `GET /api/conversations/:id/capabilities` lists the published agents, tools and skills the caller may use there (tenant, workspace, clearance, the conversation's ceiling, the profile's allow-list), with each tool's input schema and side-effect class | An entry above the conversation's ceiling is never listed, and calling it by name is refused the same way | 3 |
| B-4002 | A person calls a tool: the composer's `/tool` sends arguments (a form from the tool's JSON schema, or text the profile turns into arguments) through the dispatcher and the tool-call guardrail; the call and its result join the conversation as a tool turn the model sees next | A call the guardrail holds shows as held, and runs only when a reviewer approves it in the flag queue | 5 |
| B-4003 | Write and destructive tools in chat, user- or model-proposed, behind an in-chat approval card: write tools run on the caller's own approval, destructive ones and `confirm: always` ones also need the guardrail's approver when a rule says so; denied and expired cards are recorded | A write tool runs only after its card is approved, and a denied card leaves no side effect | 5 |
| B-4004 | `@agent` in a conversation starts an agent run bound to it: input is the message plus, when the person allows it, the recent turns within the agent's label; the run's steps stream into a run card; its answer becomes an assistant turn attributed to the agent; budgets, approvals and cancel as in Runs | A run started from chat shows in Runs with a link back, and cancelling it from the chat stops it | 8 |
| B-4005 | Skills on a conversation: `+skill` adds a published skill's instructions to the conversation's system prompt (sticky until removed, or for one turn), shown as chips; the profile can restrict which skills apply | Removing a skill leaves its instructions out of the very next turn | 3 |
| B-4006 | The model may hand a turn to an agent: agents on a profile's list are offered as tools (`agent:<name>`), run as in B-4004 within the chain's depth and budgets (B-4101) | An agent offered as a tool cannot start itself again past the chain's depth limit | 5 |
| B-4007 | Prototype board for the Chat screen additions: the `/` and `@` and `+` pickers, tool, approval and run cards, skill chips, their states and copy; the smoke run clean | The board passes the prototype smoke run in light and dark | 3 |
| B-4008 | Console: the live Chat screen gets the pickers and cards from B-4007, keyboard-first, with the run card linking to Runs; joins the Playwright suite with axe-core and the reflow checks | An agent run, a held tool call and a skill chip work end to end in the e2e suite with no axe or reflow finding | 8 |
| B-4009 | Chaining in chat, moved here from B-41 with this epic: `/workflow` starts a published workflow from a conversation (a form from its input schema, a run card, its approvals as cards in the conversation); a call held anywhere in a chain started from chat is approved from the root conversation's card (B-4106); a chat run card opens the chain tree (B-4109) | A workflow started from chat pauses on an approval card in the conversation, and approving it there resumes the chain | 3 |

### B-38 Model and dataset import wizard, second half (29 points)

Moved from 1.5.0's Sprint 33 on 2026-10-05; the first half (B-3801 to B-3803: repositories, browse and model import)
ships in 1.5.0. The epic's description, sources and permissions are in [Backlog-1.5.0.md](Backlog-1.5.0.md) (B-38).

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-3804 | Dataset import: configurations, splits, resources and API paging (CKAN datastore, Socrata, SDMX, e-Stat, OGD), schema preview with PII flags, sampling above the quota, scrub and versioning into `training_datasets` | An imported version has a manifest, hash and scrub report identical in shape to an inline one | 8 |
| B-3805 | Knowledge sets: `knowledge_sources.kind = dataset` with column mapping (title, text, metadata), grouping by a column, refresh schedules that follow the publisher, citations back to the row | A monthly SDMX table refreshes on schedule and the index swaps without downtime | 8 |
| B-3806 | Classifier eval sets and imported classifier engines: rows into an eval set with minimum-sample warnings; a text-classification model served by the classifier worker | An imported eval set shows precision and recall per label on the Classifiers screen | 5 |
| B-3807 | Import screen: the wizard, the Imports queue with cancel, retry and logs, the Repositories tab; entry points on Models, Training, Classifiers and Knowledge; Playwright and axe coverage for every state on the board | Every state on the board is reachable in the e2e suite in light and dark | 8 |

## Release

| ID | Item | Pts |
| --- | --- | --- |
| B-5901 | Version `1.7.0`, the CHANGELOG, `docs/api.md`, `docs/permissions.md`, `docs/accessibility.md` and the known-gaps sections updated as each item lands; the full Playwright suite run locally at the end of the release, its findings fixed and the cross-screen sweeps (`a-first-look`, `zz-every-screen`, `y-accessibility`, `y-reflow`, `y-reflow-overlays`) green (owner, 2026-10-06: sprints run only the specs of the screens they change) (Sprint 38) | The full Playwright suite passes locally and in CI |

## Still deferred

| Item | Why |
| --- | --- |
| Server log view in the console (B-57) | 1.7 or later per the platform administration decisions; traces and metrics only for now |

## Open decisions

None yet.

## Risks

| Risk | Effect | Mitigation |
| --- | --- | --- |
| Chat calls write tools | A person approves an action they did not read | Approval cards show the tool, its side-effect class and the exact arguments; destructive tools follow the guardrail's approver rules (B-4003) |
| Dataset sources change shape | Imports and refreshes break on a publisher's schema change | Schema preview on every version, refresh jobs that fail soft and keep the last good version (B-3804, B-3805) |
