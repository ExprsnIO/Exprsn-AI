import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { totp } from '../src/identity/totp.js';
import { parseObject } from '../src/dav/ics.js';
import { calendarFilterMatches, cardFilterMatches, textMatches } from '../src/dav/filters.js';
import { parseBody } from '../src/dav/xml.js';
import { harness, localUser, login, loginAdmin, type Harness } from './helpers.js';
import { card, davClient, davUser, event } from './dav-helpers.js';

/*
 * Sprint 30 (1.5.0): the WebDAV core and app passwords (B-3101), CalDAV over personal calendars and group events
 * (B-3102), CardDAV over the directory and personal address books (B-3103). The conformance replay (B-3104) is in
 * sprint30-dav-conformance.test.ts.
 */

const PROPFIND = (props: string) => `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:card="urn:ietf:params:xml:ns:carddav" xmlns:cs="http://calendarserver.org/ns/"><d:prop>${props}</d:prop></d:propfind>`;

const hrefs = (xml: string): string[] => [...xml.matchAll(/<d:href>([^<]*)<\/d:href>/g)].map((m) => decodeURIComponent(m[1]!));

describe('DAV app passwords (B-3101)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('needs a fresh second factor to create, carries DAV-only scopes, lists last use and stops at once when revoked', async () => {
    // A member without a second factor is told to set one up.
    await localUser(h, 'nofactor', ['member']);
    const nf = await login(h, 'nofactor');
    expect((await nf.agent.post('/api/me/app-passwords').set('x-csrf-token', nf.csrf).send({ name: 'Phone', scopes: ['caldav'] }).expect(403)).body.step).toBe('mfa');

    // An admin (a role that requires MFA) may have one: signing in with the factor is a fresh step-up.
    await localUser(h, 'ta', ['tenant-admin']);
    const a = await loginAdmin(h, 'ta');
    const created = (await a.agent.post('/api/me/app-passwords').set('x-csrf-token', a.csrf).send({ name: 'iPhone', scopes: ['caldav', 'carddav'] }).expect(201)).body;
    expect(created.password).toMatch(/^exai_d1_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
    expect(created).toMatchObject({ name: 'iPhone', scopes: ['caldav', 'carddav'], state: 'active', username: 'ta' });
    expect(created.server.caldav).toMatch(/\/\.well-known\/caldav$/);

    // A stale factor: a password step-up does not count, a TOTP one does.
    const session = (await h.s.db('sessions').where({ user_id: (await h.s.users.list(h.tenantId)).find((u) => u.username === 'ta')!.id }).first())!;
    await h.s.db('sessions').where({ id: session.id }).update({ mfa_verified_at: Date.now() - 3600_000, auth_at: Date.now() - 3600_000 });
    const stale = await a.agent.post('/api/me/app-passwords').set('x-csrf-token', a.csrf).send({ name: 'Mac', scopes: ['caldav'] }).expect(401);
    expect(stale.body).toMatchObject({ step_up: true, factor: true });
    await a.agent.post('/api/me/step-up').set('x-csrf-token', a.csrf).send({ password: 'correct horse battery staple' }).expect(200);
    await a.agent.post('/api/me/app-passwords').set('x-csrf-token', a.csrf).send({ name: 'Mac', scopes: ['caldav'] }).expect(401);
    await a.agent.post('/api/me/step-up').set('x-csrf-token', a.csrf).send({ code: totp.generate(a.totpSecret, Date.now() + 30_000) }).expect(200);
    await a.agent.post('/api/me/app-passwords').set('x-csrf-token', a.csrf).send({ name: 'Mac', scopes: ['caldav'] }).expect(201);

    // DAV accepts it; the API and the console never do (as a bearer token or as Basic).
    const dav = davClient(h, 'ta', created.password);
    await dav('PROPFIND', '/dav/').set('Depth', '0').expect(207);
    await request(h.app).get('/api/me').set('Authorization', `Bearer ${created.password}`).expect(401);
    await request(h.app).get('/api/me').auth('ta', created.password).expect(401);
    await request(h.app).get('/v1/models').set('Authorization', `Bearer ${created.password}`).expect(401);
    // A wrong username, a wrong secret and a session cookie are all refused with a Basic challenge.
    await davClient(h, 'someone', created.password)('PROPFIND', '/dav/').expect(401);
    const bad = await davClient(h, 'ta', created.password.slice(0, -2) + 'xx')('PROPFIND', '/dav/').expect(401);
    expect(bad.headers['www-authenticate']).toMatch(/^Basic realm=/);
    await request(h.app).propfind('/dav/').set('Cookie', a.cookie).expect(401);

    const list = (await a.agent.get('/api/me/app-passwords').expect(200)).body as { id: string; lastUsedAt: number | null; name: string }[];
    expect(list.find((x) => x.id === created.id)!.lastUsedAt).toBeGreaterThan(0);
    await a.agent.delete(`/api/me/app-passwords/${created.id}`).set('x-csrf-token', a.csrf).expect(204);
    await dav('PROPFIND', '/dav/').set('Depth', '0').expect(401);
    const actions = ((await h.s.db('audit_events').where({ tenant_id: h.tenantId }).where('action', 'like', 'dav.%').select('action')) as { action: string }[]).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['dav.app_password.created', 'dav.app_password.revoked']));
  });

  it('narrows the caller to the scopes of the password and to their roles', async () => {
    const u = await davUser(h, 'cardonly', { scopes: ['carddav'] });
    await u.dav('PROPFIND', '/dav/addressbooks/' + u.user.id + '/').set('Depth', '0').expect(207);
    await u.dav('PROPFIND', '/dav/calendars/' + u.user.id + '/').set('Depth', '0').expect(403);
    // Another user's home answers 404, like a path that does not exist.
    const other = await davUser(h, 'other');
    await u.dav('PROPFIND', `/dav/addressbooks/${other.user.id}/`).set('Depth', '0').expect(404);
    // An auditor holds none of the DAV permissions: refused even with a valid password.
    const aud = await davUser(h, 'aud', { roles: ['auditor'] });
    await aud.dav('PROPFIND', '/dav/').set('Depth', '0').expect(403);
  });
});

describe('DAV core and CalDAV (B-3101, B-3102)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('is discoverable: well-known redirects, the principal and its homes', async () => {
    const u = await davUser(h, 'alice');
    expect((await request(h.app).get('/.well-known/caldav').expect(301)).headers.location).toBe('/dav/');
    expect((await request(h.app).propfind('/.well-known/carddav').expect(301)).headers.location).toBe('/dav/');
    const opts = await u.dav('OPTIONS', '/dav/').expect(200);
    expect(opts.headers.dav).toContain('calendar-access');
    expect(opts.headers.dav).toContain('addressbook');
    const root = (await u.dav('PROPFIND', '/dav/').set('Depth', '0').send(PROPFIND('<d:current-user-principal/>')).expect(207)).text;
    expect(root).toContain(`<d:current-user-principal><d:href>/dav/principals/${u.user.id}/</d:href>`);
    const pr = (await u.dav('PROPFIND', `/dav/principals/${u.user.id}/`).set('Depth', '0').send(PROPFIND('<c:calendar-home-set/><card:addressbook-home-set/><c:calendar-user-address-set/><d:displayname/>')).expect(207)).text;
    expect(pr).toContain(`<cal:calendar-home-set><d:href>/dav/calendars/${u.user.id}/</d:href>`);
    expect(pr).toContain(`<card:addressbook-home-set><d:href>/dav/addressbooks/${u.user.id}/</d:href>`);
    expect(pr).toContain('mailto:alice@example.test');
    // The home lists the default calendar, made on first use.
    const home = (await u.dav('PROPFIND', `/dav/calendars/${u.user.id}/`).set('Depth', '1').send(PROPFIND('<d:resourcetype/><d:displayname/><cs:getctag/><d:sync-token/><d:current-user-privilege-set/>')).expect(207)).text;
    expect(hrefs(home)).toContain(`/dav/calendars/${u.user.id}/personal/`);
    expect(home).toContain('<cal:calendar/>');
    expect(home).toContain('<d:privilege><d:write/></d:privilege>');
  });

  it('stores calendar objects with ETags; a stale If-Match is refused with 412', async () => {
    const u = await davUser(h, 'alice');
    const cal = `/dav/calendars/${u.user.id}/personal`;
    await u.dav('PROPFIND', `/dav/calendars/${u.user.id}/`).set('Depth', '1').expect(207);
    const body = event('ev-1', 'SUMMARY:Planning\nDTSTART:20261103T090000Z\nDTEND:20261103T100000Z');
    const put = await u.dav('PUT', `${cal}/ev-1.ics`).set('Content-Type', 'text/calendar').set('If-None-Match', '*').send(body).expect(201);
    const etag = put.headers.etag as string;
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    const got = await u.dav('GET', `${cal}/ev-1.ics`).expect(200);
    expect(got.headers.etag).toBe(etag);
    expect(got.text).toContain('SUMMARY:Planning');
    await u.dav('GET', `${cal}/ev-1.ics`).set('If-None-Match', etag).expect(304);
    // A second create of the same name is refused; an update with the current ETag works.
    await u.dav('PUT', `${cal}/ev-1.ics`).set('If-None-Match', '*').send(body).expect(412);
    const changed = await u.dav('PUT', `${cal}/ev-1.ics`).set('If-Match', etag).send(body.replace('Planning', 'Planning, moved')).expect(204);
    expect(changed.headers.etag).not.toBe(etag);
    // B-3101 done-when: the old ETag is now stale.
    const stale = await u.dav('PUT', `${cal}/ev-1.ics`).set('If-Match', etag).send(body).expect(412);
    expect(stale.text).toContain('<d:error');
    await u.dav('DELETE', `${cal}/ev-1.ics`).set('If-Match', etag).expect(412);
    // The If header (RFC 4918 10.4) with an ETag condition: a stale one fails too.
    await u.dav('PUT', `${cal}/ev-1.ics`).set('If', `(["${etag.slice(1, -1)}"])`).send(body).expect(412);
    await u.dav('PUT', `${cal}/ev-1.ics`).set('If', `(Not ["${etag.slice(1, -1)}"])`).send(body.replace('Planning', 'Planning, again')).expect(204);
    // Validation: a METHOD, two UIDs, a UID used by another object.
    expect((await u.dav('PUT', `${cal}/bad.ics`).send(body.replace('VERSION:2.0', 'VERSION:2.0\r\nMETHOD:REQUEST')).expect(403)).text).toContain('valid-calendar-object-resource');
    expect((await u.dav('PUT', `${cal}/dup.ics`).send(body).expect(403)).text).toContain('no-uid-conflict');
    expect((await u.dav('PUT', `${cal}/junk.ics`).send('not a calendar').expect(403)).text).toContain('valid-calendar-data');
    // Stored sealed: the body is not in the database in the clear.
    const row = await h.s.db('dav_objects').where({ name: 'ev-1.ics' }).first();
    expect(String(row.body)).not.toContain('Planning');
    expect(Number(row.starts_at)).toBe(Date.UTC(2026, 10, 3, 9));
    await u.dav('DELETE', `${cal}/ev-1.ics`).expect(204);
    await u.dav('GET', `${cal}/ev-1.ics`).expect(404);
    const actions = ((await h.s.db('audit_events').where({ tenant_id: h.tenantId }).where('action', 'like', 'dav.%').select('action')) as { action: string }[]).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['dav.collection.created', 'dav.object.created', 'dav.object.updated', 'dav.object.deleted']));
  });

  it('syncs collections (RFC 6578) and keeps properties (MKCALENDAR, PROPPATCH)', async () => {
    const u = await davUser(h, 'alice');
    const cal = `/dav/calendars/${u.user.id}/work`;
    const mk = `<?xml version="1.0"?><c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:ic="http://apple.com/ns/ical/"><d:set><d:prop><d:displayname>Work</d:displayname><ic:calendar-color>#FF0000FF</ic:calendar-color><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set></d:prop></d:set></c:mkcalendar>`;
    await u.dav('MKCALENDAR', `${cal}/`).send(mk).expect(201);
    await u.dav('MKCALENDAR', `${cal}/`).send(mk).expect(405);
    await u.dav('MKCALENDAR', `/dav/calendars/${u.user.id}/group-x/`).send(mk).expect(403);
    const props = (await u.dav('PROPFIND', `${cal}/`).set('Depth', '0').send(PROPFIND('<d:displayname/><x:calendar-color xmlns:x="http://apple.com/ns/ical/"/><c:supported-calendar-component-set/>')).expect(207)).text;
    expect(props).toContain('<d:displayname>Work</d:displayname>');
    expect(props).toContain('#FF0000FF');
    // A VTODO is refused by a VEVENT-only calendar.
    expect((await u.dav('PUT', `${cal}/t.ics`).send(event('t', 'SUMMARY:Todo', 'VTODO')).expect(403)).text).toContain('supported-calendar-component');

    // PROPPATCH: a live property, a dead one, and a protected one (all or nothing).
    const patch = (inner: string) => `<?xml version="1.0"?><d:propertyupdate xmlns:d="DAV:" xmlns:z="urn:example:z"><d:set><d:prop>${inner}</d:prop></d:set></d:propertyupdate>`;
    await u.dav('PROPPATCH', `${cal}/`).send(patch('<d:displayname>Work stuff</d:displayname><z:order>3</z:order>')).expect(207);
    const failed = (await u.dav('PROPPATCH', `${cal}/`).send(patch('<d:getetag>x</d:getetag><z:other>1</z:other>')).expect(207)).text;
    expect(failed).toContain('HTTP/1.1 403');
    expect(failed).toContain('HTTP/1.1 424');
    const after = (await u.dav('PROPFIND', `${cal}/`).set('Depth', '0').send(PROPFIND('<d:displayname/><z:order xmlns:z="urn:example:z"/><z:other xmlns:z="urn:example:z"/>')).expect(207)).text;
    expect(after).toContain('Work stuff');
    expect(after).toMatch(/<order xmlns="urn:example:z">3<\/order>/);
    expect(after).toMatch(/HTTP\/1.1 404/);

    const syncBody = (token: string) => `<?xml version="1.0"?><d:sync-collection xmlns:d="DAV:"><d:sync-token>${token}</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>`;
    await u.dav('PUT', `${cal}/a.ics`).send(event('a', 'SUMMARY:A\nDTSTART:20261103T090000Z')).expect(201);
    await u.dav('PUT', `${cal}/b.ics`).send(event('b', 'SUMMARY:B\nDTSTART:20261104T090000Z')).expect(201);
    const first = (await u.dav('REPORT', `${cal}/`).send(syncBody('')).expect(207)).text;
    expect(hrefs(first).sort()).toEqual([`${cal}/a.ics`, `${cal}/b.ics`]);
    const token = /<d:sync-token>([^<]+)<\/d:sync-token>/.exec(first)![1]!;
    await u.dav('DELETE', `${cal}/a.ics`).expect(204);
    await u.dav('PUT', `${cal}/c.ics`).send(event('c', 'SUMMARY:C\nDTSTART:20261105T090000Z')).expect(201);
    const second = (await u.dav('REPORT', `${cal}/`).send(syncBody(token)).expect(207)).text;
    expect(hrefs(second).sort()).toEqual([`${cal}/a.ics`, `${cal}/c.ics`]);
    expect(second).toMatch(/a\.ics<\/d:href><d:status>HTTP\/1.1 404/);
    const bogus = await u.dav('REPORT', `${cal}/`).send(syncBody('https://exprsn.ai/ns/sync/nope/1/1')).expect(403);
    expect(bogus.text).toContain('valid-sync-token');

    // MOVE between one's own calendars.
    await u.dav('MKCALENDAR', `/dav/calendars/${u.user.id}/other/`).expect(201);
    await u.dav('MOVE', `${cal}/c.ics`).set('Destination', `http://localhost/dav/calendars/${u.user.id}/other/c.ics`).expect(201);
    await u.dav('GET', `/dav/calendars/${u.user.id}/other/c.ics`).expect(200);
    await u.dav('GET', `${cal}/c.ics`).expect(404);
    await u.dav('DELETE', `${cal}/`).expect(204);
    await u.dav('PROPFIND', `${cal}/`).set('Depth', '0').expect(404);
  });

  it('refuses XML with a DOCTYPE (no entities), and bodies over the cap', async () => {
    const u = await davUser(h, 'alice');
    const xxe = `<?xml version="1.0"?><!DOCTYPE d [<!ENTITY x SYSTEM "file:///etc/passwd">]><d:propfind xmlns:d="DAV:"><d:prop><d:displayname>&x;</d:displayname></d:prop></d:propfind>`;
    const r = await u.dav('PROPFIND', '/dav/').set('Depth', '0').send(xxe).expect(400);
    expect(r.text).not.toContain('root:');
    await u.dav('PROPFIND', '/dav/').set('Depth', '0').set('Content-Type', 'application/xml').send('x'.repeat(1024 * 1024 + 10)).expect(413);
    expect(() => parseBody(Buffer.from('<a xmlns="DAV:">&#xFFFFFFF;</a>'))).toThrow();
  });

  it('B-3102: group events appear in the calendar home, and an RSVP from a CalDAV client shows in the attendee list', async () => {
    const ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Design', 'internal')).id;
    const owner = await davUser(h, 'olive');
    const member = await davUser(h, 'mike');
    await h.s.tenants.addMember(ws, owner.user.id);
    await h.s.tenants.addMember(ws, member.user.id);
    const o = await login(h, 'olive');
    const m = await login(h, 'mike');
    const g = (await o.agent.post('/api/groups').set('x-csrf-token', o.csrf).send({ workspaceId: ws, name: 'Crit', visibility: 'private', joinMode: 'open' }).expect(201)).body;
    await m.agent.post(`/api/groups/${g.id}/join`).set('x-csrf-token', m.csrf).send({}).expect(200);
    const start = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 16);
    const ev = (await o.agent.post(`/api/groups/${g.id}/events`).set('x-csrf-token', o.csrf).send({ title: 'Design crit', start, timeZone: 'Europe/Berlin', durationMinutes: 90, location: 'Room 4' }).expect(201)).body;

    const home = (await member.dav('PROPFIND', `/dav/calendars/${member.user.id}/`).set('Depth', '1').send(PROPFIND('<d:displayname/>')).expect(207)).text;
    const gcal = `/dav/calendars/${member.user.id}/group-${g.id}`;
    expect(hrefs(home)).toContain(`${gcal}/`);
    const list = (await member.dav('PROPFIND', `${gcal}/`).set('Depth', '1').send(PROPFIND('<d:getetag/>')).expect(207)).text;
    expect(hrefs(list)).toContain(`${gcal}/${ev.id}.ics`);
    const got = await member.dav('GET', `${gcal}/${ev.id}.ics`).expect(200);
    got.text = got.text.replace(/\r\n /g, '');
    expect(got.text).toContain('SUMMARY:Design crit');
    expect(got.text).not.toContain('METHOD:');
    expect(got.text).toMatch(/ATTENDEE;CN="MIKE";CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:mike@example\.test/);

    // Apple Calendar and Thunderbird answer by PUTting the event back with the attendee's PARTSTAT.
    const accepted = got.text.replace('PARTSTAT=NEEDS-ACTION;RSVP=TRUE', 'PARTSTAT=ACCEPTED');
    const put = await member.dav('PUT', `${gcal}/${ev.id}.ics`).set('If-Match', got.headers.etag as string).set('Content-Type', 'text/calendar').send(accepted).expect(204);
    expect(put.headers.etag).toBeUndefined();
    const attendees = (await o.agent.get(`/api/calendar/events/${ev.id}/attendees`).expect(200)).body as { userId: string; response: string }[];
    expect(attendees).toEqual([expect.objectContaining({ userId: member.user.id, response: 'going' })]);
    // The ETag moved; the old one is stale.
    await member.dav('PUT', `${gcal}/${ev.id}.ics`).set('If-Match', got.headers.etag as string).send(accepted).expect(412);
    const again = await member.dav('GET', `${gcal}/${ev.id}.ics`).expect(200);
    again.text = again.text.replace(/\r\n /g, '');
    expect(again.text).toContain('PARTSTAT=ACCEPTED');
    // A member cannot change the event's title or create events here; the owner can.
    await member.dav('PUT', `${gcal}/${ev.id}.ics`).send(again.text.replace('SUMMARY:Design crit', 'SUMMARY:Hijacked')).expect(204);
    expect((await o.agent.get(`/api/calendar/events/${ev.id}`).expect(200)).body.title).toBe('Design crit');
    await member.dav('PUT', `${gcal}/new.ics`).send(event('new', 'SUMMARY:x\nDTSTART:20261103T090000Z')).expect(403);
    await member.dav('DELETE', `${gcal}/${ev.id}.ics`).expect(403);
    const og = await owner.dav('GET', `/dav/calendars/${owner.user.id}/group-${g.id}/${ev.id}.ics`).expect(200);
    await owner.dav('PUT', `/dav/calendars/${owner.user.id}/group-${g.id}/${ev.id}.ics`).send(og.text.replace('SUMMARY:Design crit', 'SUMMARY:Design crit (moved)')).expect(204);
    expect((await o.agent.get(`/api/calendar/events/${ev.id}`).expect(200)).body.title).toBe('Design crit (moved)');

    // A calendar-query over the group calendar, and free-busy.
    const from = new Date(Date.now() + 6 * 86_400_000).toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
    const to = new Date(Date.now() + 9 * 86_400_000).toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
    const q = `<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${from}" end="${to}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
    const qr = (await member.dav('REPORT', `${gcal}/`).set('Depth', '1').send(q).expect(207)).text;
    expect(hrefs(qr)).toEqual([`${gcal}/${ev.id}.ics`]);
    expect(qr).toContain('Design crit (moved)');
    const fb = await member.dav('REPORT', `${gcal}/`).send(`<?xml version="1.0"?><c:free-busy-query xmlns:c="urn:ietf:params:xml:ns:caldav"><c:time-range start="${from}" end="${to}"/></c:free-busy-query>`).expect(200);
    expect(fb.text).toContain('FREEBUSY;FBTYPE=BUSY:');
    // Sync over the group calendar: an RSVP change shows as a change.
    const sb = (t: string) => `<?xml version="1.0"?><d:sync-collection xmlns:d="DAV:"><d:sync-token>${t}</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>`;
    const s1 = (await member.dav('REPORT', `${gcal}/`).send(sb('')).expect(207)).text;
    const t1 = /<d:sync-token>([^<]+)</.exec(s1)![1]!;
    // A token covers changes up to two seconds before it was issued (so none is missed); later ones come again.
    await new Promise((r) => setTimeout(r, 2100));
    const s2 = (await member.dav('REPORT', `${gcal}/`).send(sb(t1)).expect(207)).text;
    const t2 = /<d:sync-token>([^<]+)</.exec(s2)![1]!;
    expect(hrefs((await member.dav('REPORT', `${gcal}/`).send(sb(t2)).expect(207)).text)).toEqual([]);
    await m.agent.post(`/api/calendar/events/${ev.id}/rsvp`).set('x-csrf-token', m.csrf).send({ response: 'maybe' }).expect(200);
    expect(hrefs((await member.dav('REPORT', `${gcal}/`).send(sb(t2)).expect(207)).text)).toEqual([`${gcal}/${ev.id}.ics`]);

    // A user outside the group sees no calendar for it.
    const outsider = await davUser(h, 'otto');
    await outsider.dav('PROPFIND', `/dav/calendars/${outsider.user.id}/group-${g.id}/`).set('Depth', '0').expect(404);
  });
});

describe('CardDAV (B-3103)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('serves the directory within the caller’s clearance: a contact above it is not returned', async () => {
    const alice = await davUser(h, 'alice', { clearance: 'internal' });
    const bob = await davUser(h, 'bob', { clearance: 'internal' });
    const carol = await davUser(h, 'carol', { clearance: 'confidential' });
    // Dan shares no workspace with Alice (owner's decision, 2026-10-05: the directory is scoped to shared workspaces).
    const dan = await davUser(h, 'dan', { clearance: 'internal' });
    const team = (await h.s.tenants.createWorkspace(h.tenantId, 'Team', 'confidential')).id;
    const other = (await h.s.tenants.createWorkspace(h.tenantId, 'Elsewhere', 'internal')).id;
    for (const u of [alice, bob, carol]) await h.s.tenants.addMember(team, u.user.id);
    await h.s.tenants.addMember(other, dan.user.id);
    const dir = `/dav/addressbooks/${alice.user.id}/directory`;
    const listed = hrefs((await alice.dav('PROPFIND', `${dir}/`).set('Depth', '1').send(PROPFIND('<d:getetag/>')).expect(207)).text);
    expect(listed).toContain(`${dir}/${bob.user.id}.vcf`);
    expect(listed).not.toContain(`${dir}/${carol.user.id}.vcf`);
    expect(listed).not.toContain(`${dir}/${dan.user.id}.vcf`);
    await alice.dav('GET', `${dir}/${dan.user.id}.vcf`).expect(404);
    await alice.dav('GET', `${dir}/${carol.user.id}.vcf`).expect(404);
    const bobCard = await alice.dav('GET', `${dir}/${bob.user.id}.vcf`).expect(200);
    expect(bobCard.text).toContain('EMAIL;TYPE=INTERNET:bob@example.test');
    expect(bobCard.headers['content-type']).toMatch(/^text\/vcard/);
    const q = (text: string) => `<?xml version="1.0"?><card:addressbook-query xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:prop><d:getetag/><card:address-data/></d:prop><card:filter><card:prop-filter name="EMAIL"><card:text-match match-type="contains">${text}</card:text-match></card:prop-filter></card:filter></card:addressbook-query>`;
    const found = (await alice.dav('REPORT', `${dir}/`).set('Depth', '1').send(q('example.test')).expect(207)).text;
    expect(hrefs(found)).toContain(`${dir}/${bob.user.id}.vcf`);
    expect(found).not.toContain('carol');
    const mg = `<?xml version="1.0"?><card:addressbook-multiget xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:prop><card:address-data/></d:prop><d:href>${dir}/${carol.user.id}.vcf</d:href><d:href>${dir}/${bob.user.id}.vcf</d:href></card:addressbook-multiget>`;
    const mgr = (await alice.dav('REPORT', `${dir}/`).send(mg).expect(207)).text;
    expect(mgr).toMatch(new RegExp(`${carol.user.id}\\.vcf</d:href><d:status>HTTP/1.1 404`));
    expect(mgr).not.toContain('carol@example.test');
    // Carol, cleared higher, sees everyone; the directory is read-only.
    expect(hrefs((await carol.dav('PROPFIND', `/dav/addressbooks/${carol.user.id}/directory/`).set('Depth', '1').expect(207)).text)).toContain(`/dav/addressbooks/${carol.user.id}/directory/${alice.user.id}.vcf`);
    await alice.dav('PUT', `${dir}/x.vcf`).send(card('x', 'X')).expect(403);
  });

  it('keeps personal address books (extended MKCOL, PUT, query, sync)', async () => {
    const u = await davUser(h, 'alice');
    const home = (await u.dav('PROPFIND', `/dav/addressbooks/${u.user.id}/`).set('Depth', '1').send(PROPFIND('<d:resourcetype/>')).expect(207)).text;
    expect(hrefs(home)).toEqual(expect.arrayContaining([`/dav/addressbooks/${u.user.id}/directory/`, `/dav/addressbooks/${u.user.id}/contacts/`]));
    const mk = `<?xml version="1.0"?><d:mkcol xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:set><d:prop><d:resourcetype><d:collection/><card:addressbook/></d:resourcetype><d:displayname>Friends</d:displayname></d:prop></d:set></d:mkcol>`;
    const mkr = await u.dav('MKCOL', `/dav/addressbooks/${u.user.id}/friends/`).send(mk);
    expect(mkr.status, mkr.text).toBe(201);
    const book = `/dav/addressbooks/${u.user.id}/friends`;
    await u.dav('PUT', `${book}/ada.vcf`).set('Content-Type', 'text/vcard').send(card('ada', 'Ada Lovelace', 'EMAIL;TYPE=WORK:ada@example.org')).expect(201);
    await u.dav('PUT', `${book}/grace.vcf`).send(card('grace', 'Grace Hopper')).expect(201);
    await u.dav('PUT', `${book}/nouid.vcf`).send('BEGIN:VCARD\r\nVERSION:3.0\r\nFN:No UID\r\nEND:VCARD\r\n').expect(403);
    const noEmail = `<?xml version="1.0"?><card:addressbook-query xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:prop><d:getetag/></d:prop><card:filter><card:prop-filter name="EMAIL"><card:is-not-defined/></card:prop-filter></card:filter></card:addressbook-query>`;
    expect(hrefs((await u.dav('REPORT', `${book}/`).set('Depth', '1').send(noEmail).expect(207)).text)).toEqual([`${book}/grace.vcf`]);
    const data = (await u.dav('GET', `${book}/ada.vcf`).expect(200)).text;
    expect(data).toContain('FN:Ada Lovelace');
  });
});

describe('query filters (B-3104 operators)', () => {
  const root = parseObject(event('x', 'SUMMARY:Café with Zoë\nDTSTART:20261110T140000Z\nDURATION:PT1H\nCATEGORIES:WORK\nATTENDEE;PARTSTAT=ACCEPTED;CN=Ada:mailto:ada@example.org\nBEGIN:VALARM\nACTION:DISPLAY\nTRIGGER:-PT15M\nEND:VALARM'));
  const f = (inner: string) => parseBody(Buffer.from(`<c:filter xmlns:c="urn:ietf:params:xml:ns:caldav"><c:comp-filter name="VCALENDAR">${inner}</c:comp-filter></c:filter>`))!;
  const ev = (inner: string) => f(`<c:comp-filter name="VEVENT">${inner}</c:comp-filter>`);
  const m = (inner: string) => calendarFilterMatches(root, ev(inner), null);

  it('evaluates every CalDAV operator', () => {
    expect(m('')).toBe(true);
    expect(calendarFilterMatches(root, f('<c:comp-filter name="VTODO"/>'), null)).toBe(false);
    expect(calendarFilterMatches(root, f('<c:comp-filter name="VTODO"><c:is-not-defined/></c:comp-filter>'), null)).toBe(true);
    expect(m('<c:time-range start="20261110T144500Z" end="20261110T160000Z"/>')).toBe(true);
    expect(m('<c:time-range start="20261110T150000Z" end="20261110T160000Z"/>')).toBe(false);
    expect(m('<c:time-range start="20261110T150000Z"/>')).toBe(false);
    expect(m('<c:time-range end="20261110T140001Z"/>')).toBe(true);
    expect(m('<c:prop-filter name="SUMMARY"><c:text-match>café</c:text-match></c:prop-filter>')).toBe(true);
    expect(m('<c:prop-filter name="SUMMARY"><c:text-match collation="i;octet">café</c:text-match></c:prop-filter>')).toBe(false);
    expect(m('<c:prop-filter name="SUMMARY"><c:text-match collation="i;unicode-casemap">ZOË</c:text-match></c:prop-filter>')).toBe(true);
    expect(m('<c:prop-filter name="SUMMARY"><c:text-match collation="i;ascii-casemap">ZOË</c:text-match></c:prop-filter>')).toBe(false);
    expect(m('<c:prop-filter name="SUMMARY"><c:text-match negate-condition="yes">Board</c:text-match></c:prop-filter>')).toBe(true);
    expect(m('<c:prop-filter name="SUMMARY"><c:text-match negate-condition="yes">Café</c:text-match></c:prop-filter>')).toBe(false);
    expect(m('<c:prop-filter name="LOCATION"><c:is-not-defined/></c:prop-filter>')).toBe(true);
    expect(m('<c:prop-filter name="CATEGORIES"><c:is-not-defined/></c:prop-filter>')).toBe(false);
    expect(m('<c:prop-filter name="LOCATION"/>')).toBe(false);
    expect(m('<c:prop-filter name="DTSTART"><c:time-range start="20261110T000000Z" end="20261111T000000Z"/></c:prop-filter>')).toBe(true);
    expect(m('<c:prop-filter name="ATTENDEE"><c:param-filter name="PARTSTAT"><c:text-match>accepted</c:text-match></c:param-filter></c:prop-filter>')).toBe(true);
    expect(m('<c:prop-filter name="ATTENDEE"><c:param-filter name="ROLE"><c:is-not-defined/></c:param-filter></c:prop-filter>')).toBe(true);
    expect(m('<c:prop-filter name="ATTENDEE"><c:param-filter name="PARTSTAT"><c:is-not-defined/></c:param-filter></c:prop-filter>')).toBe(false);
    expect(m('<c:comp-filter name="VALARM"><c:time-range start="20261110T134000Z" end="20261110T135000Z"/></c:comp-filter>')).toBe(true);
    expect(m('<c:comp-filter name="VALARM"><c:time-range start="20261110T135000Z" end="20261110T140000Z"/></c:comp-filter>')).toBe(false);
    expect(() => m('<c:prop-filter name="SUMMARY"><c:text-match collation="i;klingon">x</c:text-match></c:prop-filter>')).toThrow(/collation/);
  });

  it('evaluates every CardDAV operator, with match types and anyof/allof', () => {
    const vc = parseObject(card('a', 'Ada Lovelace', 'EMAIL;TYPE=WORK:ada@example.org\nNICKNAME:Countess'));
    const cf = (inner: string, test = 'anyof') => parseBody(Buffer.from(`<card:filter xmlns:card="urn:ietf:params:xml:ns:carddav" test="${test}">${inner}</card:filter>`))!;
    const tm = (name: string, text: string, mt = 'contains', extra = '') => `<card:prop-filter name="${name}"><card:text-match match-type="${mt}"${extra}>${text}</card:text-match></card:prop-filter>`;
    expect(cardFilterMatches(vc, cf(tm('FN', 'ada', 'starts-with')))).toBe(true);
    expect(cardFilterMatches(vc, cf(tm('FN', 'lovelace', 'ends-with')))).toBe(true);
    expect(cardFilterMatches(vc, cf(tm('FN', 'ada', 'equals')))).toBe(false);
    expect(cardFilterMatches(vc, cf(tm('FN', 'ada lovelace', 'equals')))).toBe(true);
    expect(cardFilterMatches(vc, cf(tm('FN', 'Grace', 'contains', ' negate-condition="yes"')))).toBe(true);
    expect(cardFilterMatches(vc, cf(tm('FN', 'Grace') + tm('NICKNAME', 'count'), 'anyof'))).toBe(true);
    expect(cardFilterMatches(vc, cf(tm('FN', 'Grace') + tm('NICKNAME', 'count'), 'allof'))).toBe(false);
    expect(cardFilterMatches(vc, cf('<card:prop-filter name="TEL"><card:is-not-defined/></card:prop-filter>'))).toBe(true);
    expect(cardFilterMatches(vc, cf('<card:prop-filter name="EMAIL"><card:param-filter name="TYPE"><card:text-match match-type="equals">work</card:text-match></card:param-filter></card:prop-filter>'))).toBe(true);
    expect(cardFilterMatches(vc, cf('<card:prop-filter name="EMAIL" test="allof"><card:param-filter name="TYPE"><card:text-match match-type="equals">home</card:text-match></card:param-filter><card:text-match>ada</card:text-match></card:prop-filter>'))).toBe(false);
    expect(textMatches('ÉMILE', { text: 'émile', collation: 'i;unicode-casemap', matchType: 'equals', negate: false })).toBe(true);
  });
});
