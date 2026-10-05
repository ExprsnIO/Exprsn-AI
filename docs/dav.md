# CalDAV, CardDAV and WebDAV

Exprsn-AI speaks the standard calendar and contact protocols, so Apple Calendar and Contacts, Thunderbird, DAVx5 and
other DAV clients reach the same data the console shows, through the same checks. The protocols are new front doors:
group events stay B-25 events (with their RSVPs and labels), the directory stays the tenant's users, and every read
and write goes through the services, policy pipeline and audit chain the API uses.

| Item | What |
| --- | --- |
| B-3101 | The WebDAV core: PROPFIND, PROPPATCH, REPORT, ETags with `If-Match`, `sync-collection` (RFC 6578), `/.well-known/caldav` and `/.well-known/carddav`, app passwords |
| B-3102 | CalDAV (RFC 4791): personal calendars and the calendars of one's groups; `calendar-query`, `calendar-multiget`, `free-busy-query`; RSVPs written back |
| B-3103 | CardDAV (RFC 6352): the directory as a read-only address book within one's clearance, and personal address books |
| B-3104 | A recorded conformance run of Apple, Thunderbird and DAVx5 exchanges, replayed in CI |

## Setting up a client

1. In the console's settings (or `POST /api/me/app-passwords`), create an **app password** for the device. Creating
   one needs a second factor confirmed within the step-up window (`STEPUP_WINDOW_SECONDS`): sign in with your factor,
   or confirm with a code or a passkey. A password confirmation does not count, and an account without a second
   factor sets one up first. Choose its scopes: `caldav` (calendars and group events), `carddav` (contacts) and
   `webdav` (the file store, from B-32). The password is shown once; it can expire (30 to 365 days) or not.
2. In the client, add an account with the server's address (`https://<your server>`), your **username** and the app
   password. Clients that discover the service find `/.well-known/caldav` and `/.well-known/carddav`, which redirect
   to `/dav/`; others take the URL `https://<your server>/dav/` directly.

| Client | Account type | Server |
| --- | --- | --- |
| Apple Calendar, Reminders (macOS, iOS) | Other CalDAV account, manual | `https://<server>/dav/` (or the host name alone) |
| Apple Contacts | Other CardDAV account, manual | `https://<server>/dav/` |
| Thunderbird | New calendar, on the network, CalDAV; address book: CardDAV | `https://<server>/dav/calendars/<user id>/personal/`, or let it discover from `https://<server>/` |
| DAVx5 (Android) | Log in with URL and user name | `https://<server>/` |

The settings list shows each app password's last use (time, address and client). Revoking one stops it at once: the
next request with it is refused. App passwords authenticate `/dav` only: the API, `/v1` and the console never accept
them, as a bearer token or as HTTP Basic; and sessions and cookies never authenticate `/dav`.

## The namespace

| Path | What |
| --- | --- |
| `/dav/` | The root; `current-user-principal` names your principal |
| `/dav/principals/<user id>/` | Your principal: `calendar-home-set`, `addressbook-home-set`, `calendar-user-address-set` (your email, `urn:x-exprsn:user:<id>` and the principal URL) |
| `/dav/calendars/<user id>/` | Your calendar home: your personal calendars and one calendar per group you belong to |
| `/dav/calendars/<user id>/<name>/` | A personal calendar (`personal` is made the first time the home is listed); `MKCALENDAR` makes more |
| `/dav/calendars/<user id>/group-<group id>/<event id>.ics` | A group event |
| `/dav/addressbooks/<user id>/` | Your address book home |
| `/dav/addressbooks/<user id>/directory/<user id>.vcf` | A person in the directory (read-only) |
| `/dav/addressbooks/<user id>/<name>/` | A personal address book (`contacts` is made on first use); an extended `MKCOL` makes more |

Paths name your own homes only; another user's id answers 404, as a path that does not exist.

## Behaviour

**Authentication and limits.** HTTP Basic with the username (or `username@tenant-slug`) and an app password. When the
deployment runs on HTTPS (`COOKIE_SECURE`), DAV over plain HTTP is refused before credentials are read. Failed
attempts are limited to 20 a minute per address (then 429 without checking) and 10 a minute per app password.
Requests are limited per user at `API_RATE_PER_MINUTE`. The request's permissions are the intersection of the app
password's scopes (`caldav`: `calendars:*` and `groups:*`; `carddav`: `contacts:*`; `webdav`: `files:*`) and what the
owner's roles grant at the time of the request, so demoting a user demotes their devices; a suspended or disabled user
is refused. Because creating an app password needed a fresh second factor, a DAV request counts as MFA-verified
(roles that require MFA may use DAV); the password passes MFA nowhere else.

**XML.** Request bodies are read raw (at most 1 MiB of XML, 1 MiB per calendar object or vCard) and parsed by the
same strict parser as SAML: no DOCTYPE (so no entity expansion or external entities), no processing instructions, at
most 64 levels deep. Errors with a precondition (RFC 4918 16, RFC 4791 and RFC 6352) answer a `<d:error>` naming it,
with the trace id.

**ETags and conditions.** Every object has a strong ETag. `If-Match` with a stale ETag is 412, as is `If-None-Match:
*` on an existing resource, and the If header (RFC 4918 10.4) is evaluated on ETags (and on lock tokens, from B-32).
`GET` with a matching `If-None-Match` is 304.

**Properties.** PROPFIND supports `prop`, `allprop` (with `include`) and `propname`, Depth 0, 1 and infinity (up to
5000 resources; more is 403 `propfind-finite-depth`). PROPPATCH is all or nothing (a refused property makes the rest
424): on personal collections it sets `displayname`, `calendar-description`, `addressbook-description`, Apple's
`calendar-color` and `calendar-timezone`; any other property is a dead property, kept sealed (at most 200 per
resource, 64 KB each). On a group calendar dead properties (a colour, an order) are your own and nobody else sees
them. Protected properties answer 403 `cannot-modify-protected-property`.

**Sync.** `sync-collection` (Depth 0, level 1) works on personal calendars and address books (a change counter and
tombstones kept 90 days; an older token is refused with `valid-sync-token` and the client syncs afresh), on group
calendars and on the directory (a time and a digest of what existed then: changes since that time are reported, and
when something that existed is gone, or newly visible from before, the token is refused so the client fetches the
collection again). `getctag` is the current sync token.

**CalDAV.** Personal calendar objects are validated (one VCALENDAR, no METHOD, one kind of component the calendar
takes, one UID unique in the calendar) and stored as sent, sealed with the tenant key, with their time span indexed so
time-range queries do not open every object. `calendar-query` supports every operator of RFC 4791 9.7 (see the
conformance run), `calendar-multiget` and `free-busy-query` (busy periods of events that are not transparent or
cancelled). `calendar-data` is always the whole object (a `comp`/`prop` selection and `expand` are not applied).
COPY and MOVE move objects between your own calendars (Apple does this when you change an event's calendar).

**Group events.** A group calendar lists the group's events you may read (by the group's rules and your clearance),
cancelled ones with `STATUS:CANCELLED`. Each renders with the organiser, the attendees who said going or maybe (and,
for moderators, those who declined), and you: with your answer, or `NEEDS-ACTION` with `RSVP=TRUE` when you may
answer. When your client answers (it PUTs the event back with your `PARTSTAT`), `ACCEPTED`, `TENTATIVE` and
`DECLINED` become your RSVP (going, maybe, declined) with the event's capacity and guest rules; the API's refusals
come back as 409 or 403. Moderators and owners may also change the title, location, description and times, or cancel
the event (`STATUS:CANCELLED` or DELETE); for others those changes are ignored. The server's version then differs from
what was sent, so no ETag comes back and the client fetches it again. New events are created in the console.

**CardDAV.** The directory lists the tenant's active users whose clearance is at or below yours: a person's entry
carries their clearance as its label, so a contact above your clearance is never listed, returned, synced or matched.
Entries are vCard 3.0 with the name, username, email and the tenant's name. Personal address books take vCard 3.0
and 4.0 with a UID (unique in the book) and FN. `addressbook-query` supports every operator of RFC 6352 10.5
(`test="anyof|allof"`, match types, collations, negation, `is-not-defined`, param filters) and `limit`;
`address-data` may name the properties to return.

**Audit.** App passwords created and revoked, collections created, changed and deleted, objects created, updated,
copied, moved and deleted, and property changes are in the audit chain (`dav.*`), with the app password in the
actor's `via`. RSVPs and event changes are the groups service's own entries (`group.event.*`). Denials are audited as on
the API.

## Conformance (B-3104)

`server/test/fixtures/dav/` holds the exchanges of Apple Calendar and Contacts, Thunderbird and DAVx5: each request
as the client sends it (method, headers, body and User-Agent) and what the answer must hold (status, the exact set of
hrefs, text it must contain). `server/test/sprint30-dav-conformance.test.ts` replays them in order against a seeded
account on every CI run, and fails when an operator of either filter grammar is missing from the run. The fixtures
were written from the clients' request formats (their sources and published traces), not captured from devices on
this server; add a captured exchange the same way when a client misbehaves.

exprsn-platform's CalDAV, which this replaces, negated text matches wrongly and ignored `is-not-defined`; each such
operator has its own exchange here.

## Not supported

- Scheduling (RFC 6638): no inbox or outbox, no iTIP; invitations are group events, and answers are RSVPs as above.
- Recurrence expansion: a time-range test on a recurring object uses the span from its first start to its last
  possible end (open-ended without COUNT or UNTIL), so a query may return a recurring object with no instance in the
  range; clients expand recurrences themselves.
- A TZID that is not an IANA zone name is read with the object's own VTIMEZONE's standard offset (no daylight rules).
- `expand-property` answers the properties without expanding them; principal searches are not supported.
- WebDAV for the file store, locks and quotas are B-32 (below, when present).
