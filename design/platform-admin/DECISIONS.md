# Decisions: Exprsn-platform administration screens

Written by `decide.mjs`; edit the answers there, not here. 20 of 20 items answered, last change 2026-10-05 19:49 UTC.

| ID | Screen | Item | Decision | Note | When |
| --- | --- | --- | --- | --- | --- |
| Q1 | Jobs and queues | Where does the tenant cache live? | A tab on Jobs and queues |  | 2026-10-05 |
| Q2 | Configuration | May the console change settings? | Database overrides for every setting, dual control |  | 2026-10-05 |
| Q3 | Overview | Where does Overview sit? | First in the Admin group; Platform unchanged |  | 2026-10-05 |
| Q4 | Social and messaging | Which permission governs social and messaging policies? | A new social:manage for feed, groups, messaging and relations policy; moderation:manage for held posts and the moderation-facing parts |  | 2026-10-05 |
| Q5 | Social and messaging | Who may export another member's conversation? | Dual control: a second platform admin approves |  | 2026-10-05 |
| Q6 | Social and messaging | Do groups get categories? | A tenant-managed category list |  | 2026-10-05 |
| Q7 | Overview | Should the console show server logs? | 1.7 or later; traces and metrics only for now (B-57) |  | 2026-10-05 |
| Q8 | Scope | Live streaming administration? | Dropped: no live streaming in Exprsn-AI (B-43) |  | 2026-10-05 |
| Q9 | Jobs and queues | Who sees which jobs? | System admins see all with a tenant filter; tenant admins see their own |  | 2026-10-05 |
| Q10 | Storage | Deleting orphan blobs needs what? | Dry run, then one admin with a reason |  | 2026-10-05 |
| Q11 | Tenants | Tenant provisioning templates? | Add Create from template to the Tenants screen |  | 2026-10-05 |
| Q12 | Planning | Which sprint takes B-4202 to B-4207? | Sprint 35, the first of 1.6.0 |  | 2026-10-05 |
| Q13 | Prototype | Who adds the five icons to app.js? | The sprint-29 session adds overview, jobs, storage, configuration, social when the screens go live |  | 2026-10-05 |
| Q14 | Overview | Drain an instance from the console? | From the console with confirm and a recent sign-in |  | 2026-10-05 |
| Q15 | Overview | Acknowledging an alert is for whom? | Tenant-wide, audited |  | 2026-10-05 |
| Q16 | Storage | Migrate the blob store from the console? | Design it as proposed on the Stores tab |  | 2026-10-05 |
| C1 | Branch | This branch starts from the committed sprint-29 head | Resolved: PR #42 merged into sprint-29 on 2026-10-05 |  | 2026-10-05 |
| C2 | Prototype | Nav entries are injected at load time | Acknowledged for the prototype |  | 2026-10-05 |
| C3 | Backlog | Backlog-1.5.0.md gains an epic on this branch | Resolved: sprint-29 renumbered the epic to B-42 |  | 2026-10-05 |
| C4 | Scope | Not designed: Live, governance voting, server logs | Superseded by grooming: live streaming dropped, governance and logs wait for 1.7 |  | 2026-10-05 |

## Lines for Backlog-1.5.0.md, Open decisions

- [x] Where does the tenant cache live: A tab on Jobs and queues (Q1, design/platform-admin).
- [x] May the console change settings: Database overrides for every setting, dual control (Q2, design/platform-admin).
- [x] Where does Overview sit: First in the Admin group; Platform unchanged (Q3, design/platform-admin).
- [x] Which permission governs social and messaging policies: A new social:manage for feed, groups, messaging and relations policy; moderation:manage for held posts and the moderation-facing parts (Q4, design/platform-admin).
- [x] Who may export another member's conversation: Dual control: a second platform admin approves (Q5, design/platform-admin).
- [x] Do groups get categories: A tenant-managed category list (Q6, design/platform-admin).
- [x] Should the console show server logs: 1.7 or later; traces and metrics only for now (B-57) (Q7, design/platform-admin).
- [x] Live streaming administration: Dropped: no live streaming in Exprsn-AI (B-43) (Q8, design/platform-admin).
- [x] Who sees which jobs: System admins see all with a tenant filter; tenant admins see their own (Q9, design/platform-admin).
- [x] Deleting orphan blobs needs what: Dry run, then one admin with a reason (Q10, design/platform-admin).
- [x] Tenant provisioning templates: Add Create from template to the Tenants screen (Q11, design/platform-admin).
- [x] Which sprint takes B-4202 to B-4207: Sprint 35, the first of 1.6.0 (Q12, design/platform-admin).
- [x] Who adds the five icons to app.js: The sprint-29 session adds overview, jobs, storage, configuration, social when the screens go live (Q13, design/platform-admin).
- [x] Drain an instance from the console: From the console with confirm and a recent sign-in (Q14, design/platform-admin).
- [x] Acknowledging an alert is for whom: Tenant-wide, audited (Q15, design/platform-admin).
- [x] Migrate the blob store from the console: Design it as proposed on the Stores tab (Q16, design/platform-admin).
