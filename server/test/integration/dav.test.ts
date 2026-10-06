/*
 * Sprint 30 (1.5.0), CalDAV and CardDAV, against real databases. Each block runs when its variable is set:
 *
 *   TEST_PG_URL / TEST_MYSQL_URL   migration 032_dav; an app password verified, used and revoked; a personal calendar
 *                                  object stored sealed with its indexed times, read back, updated with If-Match (a
 *                                  stale ETag is 412), queried by time range and synced (the change counter and
 *                                  tombstones); dead properties; the directory filtered by clearance; a group event
 *                                  answered over CalDAV becoming the attendee's RSVP. The app listens on
 *                                  127.0.0.1:${TEST_DAV_PORT:-55531}.
 */
import type { Server } from 'node:http';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';
import { createDb, migrate } from '../../src/db/knex.js';
import { migrationSource } from '../../src/db/migrations/index.js';
import { createApp } from '../../src/http/app.js';
import { loadPrincipal } from '../../src/http/middleware.js';
import { createLogger, Metrics } from '../../src/observability/index.js';
import { createServices } from '../../src/services.js';
import { testConfig } from '../helpers.js';

const PORT = Number(process.env.TEST_DAV_PORT ?? 55531);
const ics = (uid: string, extra: string) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN', 'BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20261001T000000Z', ...extra.split('\n'), 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');

for (const d of [
  { name: 'PostgreSQL', client: 'pg' as const, url: process.env.TEST_PG_URL },
  { name: 'MySQL', client: 'mysql' as const, url: process.env.TEST_MYSQL_URL }
]) {
  describe.skipIf(!d.url)(`DAV on ${d.name}`, () => {
    it('migrates 032_dav and serves app passwords, CalDAV and CardDAV', async () => {
      const cfg = testConfig({ DB_CLIENT: d.client, DATABASE_URL: d.url! });
      const db = createDb(cfg);
      await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
      await migrate(db);
      const s = createServices(cfg, db, createLogger('silent', false), new Metrics());
      let server: Server | null = null;
      try {
        for (const t of ['dav_app_passwords', 'dav_collections', 'dav_objects', 'dav_tombstones', 'dav_properties']) expect(await db.schema.hasTable(t)).toBe(true);
        await bootstrap(s);
        const tenant = (await s.tenants.bySlug(cfg.DEFAULT_TENANT))!;
        const person = async (username: string, clearance: 'internal' | 'confidential') => {
          const u = await s.users.create(tenant.id, { username, displayName: username.toUpperCase(), clearance });
          await s.users.update(tenant.id, u.id, { clearance_direct: clearance });
          await db('users').where({ id: u.id }).update({ email: `${username}@example.test` });
          await s.users.setRoles(u.id, 'direct', ['member']);
          const { password, row } = await s.dav.passwords.create({ tenantId: tenant.id, userId: u.id, name: 'Laptop', scopes: ['caldav', 'carddav'], ttlDays: 30 });
          return { u, password, row };
        };
        const ann = await person('ann', 'internal');
        const ben = await person('ben', 'internal');
        const cy = await person('cy', 'confidential');

        const app = createApp(s);
        server = await new Promise<Server>((resolve) => {
          const srv = app.listen(PORT, '127.0.0.1', () => resolve(srv));
        });
        const base = `http://127.0.0.1:${PORT}`;
        const dav = (method: string, path: string, who = ann) => (request(base) as unknown as Record<string, (p: string) => request.Test>)[method.toLowerCase()]!(path).auth(who.u.username, who.password);

        // The personal calendar: made on first listing, objects sealed, ETags, If-Match.
        await dav('PROPFIND', `/dav/calendars/${ann.u.id}/`).set('Depth', '1').expect(207);
        const cal = `/dav/calendars/${ann.u.id}/personal`;
        const put = await dav('PUT', `${cal}/a.ics`).set('Content-Type', 'text/calendar').send(ics('a', 'SUMMARY:Alpha\nDTSTART:20261103T090000Z\nDTEND:20261103T100000Z')).expect(201);
        const row = await db('dav_objects').where({ name: 'a.ics' }).first();
        expect(String(row.body)).not.toContain('Alpha');
        expect(Number(row.starts_at)).toBe(Date.UTC(2026, 10, 3, 9));
        expect((await dav('GET', `${cal}/a.ics`).expect(200)).text).toContain('SUMMARY:Alpha');
        await dav('PUT', `${cal}/a.ics`).set('If-Match', put.headers.etag as string).send(ics('a', 'SUMMARY:Alpha 2\nDTSTART:20261103T090000Z')).expect(204);
        await dav('PUT', `${cal}/a.ics`).set('If-Match', put.headers.etag as string).send(ics('a', 'SUMMARY:Alpha 3\nDTSTART:20261103T090000Z')).expect(412);
        await dav('PUT', `${cal}/b.ics`).send(ics('b', 'SUMMARY:Beta\nDTSTART:20261203T090000Z')).expect(201);
        const q = `<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="20261101T000000Z" end="20261201T000000Z"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
        const qr = (await dav('REPORT', `${cal}/`).set('Depth', '1').send(q).expect(207)).text;
        expect(qr).toContain('a.ics');
        expect(qr).not.toContain('b.ics');
        const sync = (t: string) => `<?xml version="1.0"?><d:sync-collection xmlns:d="DAV:"><d:sync-token>${t}</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>`;
        const first = (await dav('REPORT', `${cal}/`).send(sync('')).expect(207)).text;
        const token = /<d:sync-token>([^<]+)</.exec(first)![1]!;
        await dav('DELETE', `${cal}/b.ics`).expect(204);
        const second = (await dav('REPORT', `${cal}/`).send(sync(token)).expect(207)).text;
        expect(second).toMatch(/b\.ics<\/d:href><d:status>HTTP\/1.1 404/);
        expect(second).not.toContain('a.ics');
        // Dead properties, sealed.
        await dav('PROPPATCH', `${cal}/`).send('<?xml version="1.0"?><d:propertyupdate xmlns:d="DAV:"><d:set><d:prop><z:order xmlns:z="urn:x">7</z:order></d:prop></d:set></d:propertyupdate>').expect(207);
        expect(String((await db('dav_properties').first()).value)).not.toContain('7<');

        // The directory: people who share a workspace with the caller, within clearance (Cy shares it but is cleared
        // higher, so only clearance hides Cy).
        const ws = await s.tenants.createWorkspace(tenant.id, 'Studio', 'internal');
        await s.tenants.addMember(ws.id, ann.u.id);
        await s.tenants.addMember(ws.id, ben.u.id);
        await s.tenants.addMember(ws.id, cy.u.id);
        const dir = (await dav('PROPFIND', `/dav/addressbooks/${ann.u.id}/directory/`).set('Depth', '1').expect(207)).text;
        expect(dir).toContain(`${ben.u.id}.vcf`);
        expect(dir).not.toContain(`${cy.u.id}.vcf`);

        // A group event answered over CalDAV is the attendee's RSVP.
        const benCtx = { p: (await loadPrincipal(s, tenant.id, ben.u.id, {}))!, ip: null };
        benCtx.p.workspaceId = ws.id;
        const g = await s.groups.create(benCtx, { workspaceId: ws.id, name: 'Crit', visibility: 'public', joinMode: 'open' });
        const ev = await s.calendar.create(benCtx, g.id, { title: 'Review', start: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 16), timeZone: 'UTC', durationMinutes: 60 });
        const href = `/dav/calendars/${ann.u.id}/group-${g.id}/${ev.id}.ics`;
        const got = (await dav('GET', href).expect(200)).text.replace(/\r\n /g, '');
        expect(got).toContain('PARTSTAT=NEEDS-ACTION');
        await dav('PUT', href).send(got.replace('PARTSTAT=NEEDS-ACTION;RSVP=TRUE', 'PARTSTAT=TENTATIVE')).expect(204);
        expect(await s.calendar.attendees(benCtx.p, ev.id)).toEqual([expect.objectContaining({ userId: ann.u.id, response: 'maybe' })]);

        // Revoked: refused at once.
        await s.dav.passwords.revoke(ann.u.id, ann.row.id, ann.u.id);
        await dav('PROPFIND', '/dav/').set('Depth', '0').expect(401);
      } finally {
        if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
        await s.close();
        await db.destroy();
      }
    });
  });
}
