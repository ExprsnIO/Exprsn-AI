# Decisions: Exprsn-platform administration screens

Written by `decide.mjs`; edit the answers there, not here. 4 of 20 items answered, last change 2026-10-05 19:43 UTC.

| ID | Screen | Item | Decision | Note | When |
| --- | --- | --- | --- | --- | --- |
| Q1 | Jobs and queues | Where does the tenant cache live? | _open_ (board shows: A tab on Jobs and queues) |  |  |
| Q2 | Configuration | May the console change settings? | _open_ (board shows: Read-only view of the environment) |  |  |
| Q3 | Overview | Where does Overview sit? | _open_ (board shows: First in the Admin group; Platform unchanged) |  |  |
| Q4 | Social and messaging | Which permission governs social and messaging policies? | _open_ (board shows: tenant:manage (and platform:manage for Realtime)) |  |  |
| Q5 | Social and messaging | Who may export another member's conversation? | _open_ (board shows: Dual control: a second platform admin approves) |  |  |
| Q6 | Social and messaging | Do groups get categories? | _open_ (board shows: No categories; workspaces are the grouping) |  |  |
| Q7 | Overview | Should the console show server logs? | other |  | 2026-10-05 |
| Q8 | Scope | Live streaming administration? | other |  | 2026-10-05 |
| Q9 | Jobs and queues | Who sees which jobs? | _open_ (board shows: System admins see all with a tenant filter; tenant admins see their own) |  |  |
| Q10 | Storage | Deleting orphan blobs needs what? | _open_ (board shows: Dry run, then one admin with a reason) |  |  |
| Q11 | Tenants | Tenant provisioning templates? | Add Create from template to the Tenants screen |  | 2026-10-05 |
| Q12 | Planning | Which sprint takes B-4202 to B-4207? | Sprint 35, the first of 1.6.0 |  | 2026-10-05 |
| Q13 | Prototype | Who adds the five icons to app.js? | _open_ (board shows: The sprint-29 session adds overview, jobs, storage, configuration, social when the screens go live) |  |  |
| Q14 | Overview | Drain an instance from the console? | _open_ (board shows: From the console with confirm and a recent sign-in) |  |  |
| Q15 | Overview | Acknowledging an alert is for whom? | _open_ (board shows: Tenant-wide, audited) |  |  |
| Q16 | Storage | Migrate the blob store from the console? | _open_ (board shows: Design it as proposed on the Stores tab) |  |  |
| C1 | Branch | This branch starts from the committed sprint-29 head | _open_ (board shows: Acknowledged; merge into sprint-29 after its pending commit) |  |  |
| C2 | Prototype | Nav entries are injected at load time | _open_ (board shows: Acknowledged for the prototype) |  |  |
| C3 | Backlog | Backlog-1.5.0.md gains an epic on this branch | _open_ (board shows: Acknowledged) |  |  |
| C4 | Scope | Not designed: Live, governance voting, server logs | _open_ (board shows: Acknowledged) |  |  |

## Lines for Backlog-1.5.0.md, Open decisions

- [ ] Where does the tenant cache live: open; the board shows "A tab on Jobs and queues" (Q1, design/platform-admin).
- [ ] May the console change settings: open; the board shows "Read-only view of the environment" (Q2, design/platform-admin).
- [ ] Where does Overview sit: open; the board shows "First in the Admin group; Platform unchanged" (Q3, design/platform-admin).
- [ ] Which permission governs social and messaging policies: open; the board shows "tenant:manage (and platform:manage for Realtime)" (Q4, design/platform-admin).
- [ ] Who may export another member's conversation: open; the board shows "Dual control: a second platform admin approves" (Q5, design/platform-admin).
- [ ] Do groups get categories: open; the board shows "No categories; workspaces are the grouping" (Q6, design/platform-admin).
- [x] Should the console show server logs: other (Q7, design/platform-admin).
- [x] Live streaming administration: other (Q8, design/platform-admin).
- [ ] Who sees which jobs: open; the board shows "System admins see all with a tenant filter; tenant admins see their own" (Q9, design/platform-admin).
- [ ] Deleting orphan blobs needs what: open; the board shows "Dry run, then one admin with a reason" (Q10, design/platform-admin).
- [x] Tenant provisioning templates: Add Create from template to the Tenants screen (Q11, design/platform-admin).
- [x] Which sprint takes B-4202 to B-4207: Sprint 35, the first of 1.6.0 (Q12, design/platform-admin).
- [ ] Who adds the five icons to app.js: open; the board shows "The sprint-29 session adds overview, jobs, storage, configuration, social when the screens go live" (Q13, design/platform-admin).
- [ ] Drain an instance from the console: open; the board shows "From the console with confirm and a recent sign-in" (Q14, design/platform-admin).
- [ ] Acknowledging an alert is for whom: open; the board shows "Tenant-wide, audited" (Q15, design/platform-admin).
- [ ] Migrate the blob store from the console: open; the board shows "Design it as proposed on the Stores tab" (Q16, design/platform-admin).
