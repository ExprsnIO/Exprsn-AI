# Grooming: Backlog grooming, 1.5.0 through 1.6.0

Written by `groom.mjs`; change placements there, not here. 41 of 41 items groomed, last change 2026-10-05 19:50 UTC. Capacity 78 points a sprint.

## Capacity

| Sprint | Release | Points | Against 78 | Items |
| --- | --- | --- | --- | --- |
| 29 | 1.5.0 | 76 | fits | B-33, B-3401, B-34a, B-3601 |
| 30 | 1.5.0 | 76 | fits | B-34b, B-31, B-37, B-3602 |
| 31 | 1.5.0 | 93 | **over by 15** | B-38a, B-29, B-30, B-3406, B-3603, B-3604 |
| 32 | 1.5.0 | 71 | fits | B-39, B-3415, B-4101 |
| 33 | 1.5.0 | 69 | fits | B-38b, B-40 |
| 34 | 1.5.0 | 66 | fits | B-32, B-41b, B-3501, B-4301, B-4302, B-3605 |
| 35 | 1.6.0 | 42 | fits | B-42, B-45 |
| 36 | 1.6.0 | 40 | fits | B-44, B-46, B-48, B-47 |
| 37 | 1.6.0 | 21 | fits | B-49, B-48, B-50, B-51 |

## Sprint 29 (1.5.0, 76 points)

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-33 | Permission matrices and custom roles | A tenant admin cannot create a role holding platform:manage; every cell's explain matches policy.explain. | 24 |
| B-3401 | Prototype boards for the eleven 1.4.0 domains | Every new board passes the smoke run in light and dark. | 13 |
| B-34a | Live screens: Certificates, Vault, Plugins, Apps, Files, identity additions | Issuing a certificate, a policy explain, revoking a grant, an entity accepting a record and a shared link all work from the screens. | 34 |
| B-3601 | Low-code record queries from an index on PostgreSQL | The 1.4.0 load test's records query p95 is below 250 ms on PostgreSQL. | 5 |

## Sprint 30 (1.5.0, 76 points)

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-34b | Live screens: Moderation, Groups, Channels, Messages and feed, Roles, accessibility | Upholding an appeal restores the object; every new screen passes axe and reflow. | 36 |
| B-31 | CalDAV and CardDAV over events and the directory | An RSVP from Apple Calendar shows in the attendee list; a contact above the caller's clearance is not returned. | 24 |
| B-37 | Model-based memory management | An extracted memory names the profile that wrote it and can be rejected before it is used. | 13 |
| B-3602 | Merge MongoDB data connections | The sample-mongodb connection registers on :8091 and its knowledge base builds. | 3 |

## Sprint 31 (1.5.0, 93 points)

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-38a | Import wizard: repository registry, catalogue browse, model import | A model imported from a Hugging Face compatible hub is a draft catalogue entry with its licence recorded. | 21 |
| B-29 | AT-Protocol personal data server | A post written to Exprsn-AI's PDS appears in the reference AppView. | 42 |
| B-30 | Custom feed generator | A post from an author outside the rule never appears in the feed. | 18 |
| B-3406 | Live screen: AT-Protocol | Rotating a key from the screen updates the DID document. | 5 |
| B-3603 | RSVP capacity race | Fifty concurrent RSVPs for one place leave one attendee on all three databases. | 2 |
| B-3604 | Verify relay commit signatures on the firehose | A commit with a bad signature is dropped and audited; a good one becomes a label as before. | 5 |

## Sprint 32 (1.5.0, 71 points)

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-39 | Workflows 2: sub-workflows, agent steps, triggers, domain steps, map and loop, failures, bundles | A published workflow runs a child workflow and an agent step within their budgets, and a failed step lands in the dead-letter view. | 61 |
| B-3415 | Settings: app passwords for DAV clients | An app password never opens the API or the console. | 2 |
| B-4101 | The chain context | A tool call started from a workflow started from chat shows the whole chain in its audit entry. | 8 |

## Sprint 33 (1.5.0, 69 points)

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-38b | Import wizard: dataset import, knowledge sets, eval sets, the Import screen | A CKAN dataset becomes a knowledge base with citations back to the publisher. | 29 |
| B-40 | Agents, tools and skills in chat | A destructive tool proposed by the model waits for the in-chat approval and the run shows in the conversation. | 40 |

## Sprint 34 (1.5.0, 66 points)

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-32 | WebDAV for the file store | litmus passes basic, copymove and locks; an upload over WebDAV is scanned before it can be read. | 13 |
| B-41b | Chaining agents, skills, tools and workflows | A chain held at its third level is approved once and finishes; a cycle is refused at publish. | 39 |
| B-3501 | Release 1.5.0 | Tag 1.5.0. | 0 |
| B-4301 | User profiles: avatar, bio, profile page | Opening an author from a post shows their profile; an avatar that fails the scan is never shown. | 8 |
| B-4302 | Presence status: available, away, busy, offline | A member set to busy shows busy to a contact within five seconds and not at all to a blocked user. | 3 |
| B-3605 | IMAP adapter against a real server in CI | A message delivered to the test mailbox becomes a channel thread in CI. | 3 |

## Sprint 35 (1.6.0, 42 points)

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-42 | Platform administration live screens: Overview, Jobs, Storage, Configuration, Social | Draining an instance, pausing a job type, deleting an orphan after a dry run and revoking a calendar feed all work from the screens. | 37 |
| B-45 | Tenant provisioning templates | A tenant created from the team template signs in with its first admin in one step. | 5 |

## Sprint 36 (1.6.0, 40 points)

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-44 | Groups depth: subgroups and channels, discovery, location, trending, categories | A channel inside a group has its own members and feed; the discovery page never shows a group above the viewer's clearance. | 24 |
| B-46 | Blob deduplication by content hash | Two uploads of one file in a tenant occupy one blob; deleting one leaves the other readable. | 5 |
| B-48 | Vault extras: secret sharing, MongoDB leases, access anomalies | A burst of reveals from a new address raises a flag before the tenth reveal. | 16 | split
| B-47 | Held values on public forms are queued, not refused | A held submission appears in the moderation queue and is accepted into a record from there. | 3 |

## Sprint 37 (1.6.0, 21 points)

| ID | Item | Done when | Pts |
| --- | --- | --- | --- |
| B-49 | Quote posts and per-post visibility | An unlisted post is reachable by link and absent from every feed. | 5 |
| B-48 | Vault extras: secret sharing, MongoDB leases, access anomalies | A burst of reveals from a new address raises a flag before the tenth reveal. | 16 | split
| B-50 | Capability tokens: resource-scoped, use-limited | A token with max uses 3 is refused on its fourth use and the refusal is audited. | 8 |
| B-51 | Release 1.6.0 | Tag 1.6.0. | 0 |

## Moves from the written plan

- B-32 WebDAV for the file store: Sprint 30 (1.5.0) → Sprint 34 (1.5.0, chaining and release)
- B-38a Import wizard: repository registry, catalogue browse, model import: Sprint 30 (1.5.0) → Sprint 31 (1.5.0)
- B-38b Import wizard: dataset import, knowledge sets, eval sets, the Import screen: Sprint 31 (1.5.0) → Sprint 33 (1.5.0, chat invocation)

## 1.7 or later

- X-governance Governance: proposals and voting (13)
- X-recurrence Recurring events and VTIMEZONE in calendar feeds (8)
- X-push Web push notifications (8)
- X-sms SMS one-time codes (3)
- X-logs Server log view in the console (5)

## Dropped

- X-live Live streaming: ingest, rooms, simulcast, recordings: owner decision 2026-10-05: no live streaming in Exprsn-AI
- X-e2ee End-to-end-encrypted messaging: owner decision 2026-10-05: server-side guardrails and AI features stay

## Not yet placed

None.

## Notes

- B-48: anomaly detection (8) in Sprint 36, secret sharing and MongoDB leases in 37
