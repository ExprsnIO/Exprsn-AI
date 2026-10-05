import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { harness, type Harness } from './helpers.js';
import { card, davUser, event } from './dav-helpers.js';

/*
 * B-3104: the conformance run. Each file in test/fixtures/dav holds one client's exchanges (Apple Calendar and
 * Contacts, Thunderbird, DAVx5): the requests as the client sends them (method, headers, body, User-Agent) and what
 * the answer must hold (status, the exact set of hrefs, text it contains or must not). They are replayed in order
 * against one seeded account; a sync token an exchange captures is used by the later ones. Every filter operator of
 * calendar-query and addressbook-query appears in at least one exchange, and each must return exactly the expected
 * items (the platform's CalDAV got several of them wrong).
 */

interface Exchange {
  name: string;
  operators?: string[];
  capture?: 'token';
  request: { method: string; path: string; headers?: Record<string, string>; body: string };
  response: { status: number; hrefs?: string[]; absent?: string[]; contains?: string[] };
}
interface Fixture {
  client: string;
  userAgent: string;
  exchanges: Exchange[];
}

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'dav');
const fixtures = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => ({ file: f, ...(JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as Fixture) }));

/** Every operator of the two filter grammars (RFC 4791 9.7, RFC 6352 10.5) that the run must exercise. */
const OPERATORS = [
  'comp-filter', 'prop-filter', 'param-filter', 'is-not-defined', 'time-range', 'time-range:start-only', 'time-range:end-only', 'time-range:property', 'time-range:valarm',
  'text-match', 'negate-condition', 'collation:i;octet', 'collation:i;ascii-casemap', 'collation:i;unicode-casemap',
  'match-type:equals', 'match-type:contains', 'match-type:starts-with', 'match-type:ends-with', 'test:anyof', 'test:allof'
];

const SEED_EVENTS: Record<string, string> = {
  'e1.ics': event('e1', 'SUMMARY:Board meeting\nDTSTART:20261103T090000Z\nDTEND:20261103T100000Z\nLOCATION:Room 1\nCATEGORIES:WORK\nATTENDEE;ROLE=CHAIR;PARTSTAT=ACCEPTED:mailto:ada@example.org'),
  'e2.ics': event('e2', 'SUMMARY:Café with Zoë\nDTSTART;TZID=Europe/Berlin:20261110T150000\nDURATION:PT1H\nCLASS:PRIVATE'),
  'e3.ics': event('e3', 'SUMMARY:Holiday\nDTSTART;VALUE=DATE:20261201'),
  'e4.ics': event('e4', 'SUMMARY:Standup\nDTSTART:20260105T080000Z\nDTEND:20260105T081500Z\nRRULE:FREQ=WEEKLY;COUNT=10'),
  'e5.ics': event('e5', 'SUMMARY:Dentist\nDTSTART:20261120T100000Z\nDTEND:20261120T110000Z\nATTENDEE;PARTSTAT=TENTATIVE:mailto:bob@example.test\nBEGIN:VALARM\nACTION:DISPLAY\nDESCRIPTION:Dentist\nTRIGGER:-PT15M\nEND:VALARM'),
  't1.ics': event('t1', 'SUMMARY:File report\nDUE:20261105T170000Z\nSTATUS:NEEDS-ACTION', 'VTODO'),
  't2.ics': event('t2', 'SUMMARY:Done task\nCOMPLETED:20261001T100000Z\nSTATUS:COMPLETED', 'VTODO')
};
const SEED_CARDS: Record<string, string> = {
  'c1.vcf': card('c1', 'Ada Lovelace', 'N:Lovelace;Ada;;;\nEMAIL;TYPE=WORK:ada@example.org\nTEL;TYPE=CELL:+44 20 7946 0000'),
  'c2.vcf': card('c2', 'Émile Zola', 'EMAIL;TYPE=HOME:emile@example.fr\nNICKNAME:Zozo'),
  'c3.vcf': card('c3', 'Grace Hopper', 'ORG:US Navy')
};

describe('DAV conformance run (B-3104)', () => {
  let h: Harness;
  let vars: Record<string, string>;
  let alice: Awaited<ReturnType<typeof davUser>>;

  beforeAll(async () => {
    h = await harness();
    alice = await davUser(h, 'alice', { clearance: 'internal' });
    const bob = await davUser(h, 'bob', { clearance: 'internal' });
    const carol = await davUser(h, 'carol', { clearance: 'confidential' });
    const uid = alice.user.id;
    vars = { uid, bob: bob.user.id, carol: carol.user.id, cal: `/dav/calendars/${uid}/personal`, book: `/dav/addressbooks/${uid}/contacts`, dir: `/dav/addressbooks/${uid}/directory` };
    // The homes are listed first (as every client does), which makes the default calendar and address book.
    await alice.dav('PROPFIND', `/dav/calendars/${uid}/`).set('Depth', '1').expect(207);
    await alice.dav('PROPFIND', `/dav/addressbooks/${uid}/`).set('Depth', '1').expect(207);
    for (const [name, body] of Object.entries(SEED_EVENTS)) await alice.dav('PUT', `${vars.cal}/${name}`).set('Content-Type', 'text/calendar').send(body).expect(201);
    for (const [name, body] of Object.entries(SEED_CARDS)) await alice.dav('PUT', `${vars.book}/${name}`).set('Content-Type', 'text/vcard').send(body).expect(201);
  });
  afterAll(async () => {
    await h.close();
  });

  const fill = (s: string) => s.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
  const hrefsOf = (xml: string) => [...new Set([...xml.matchAll(/<d:href>([^<]*)<\/d:href>/g)].map((m) => decodeURIComponent(m[1]!)))];

  it('exercises every filter operator', () => {
    const used = new Set(fixtures.flatMap((f) => f.exchanges.flatMap((e) => e.operators ?? [])));
    expect(OPERATORS.filter((o) => !used.has(o))).toEqual([]);
    expect(fixtures.map((f) => f.file)).toEqual(['apple.json', 'davx5.json', 'thunderbird.json']);
  });

  for (const f of fixtures) {
    it(`replays ${f.client}`, async () => {
      for (const ex of f.exchanges) {
        const req = alice.dav(ex.request.method, fill(ex.request.path)).set('User-Agent', f.userAgent);
        for (const [k, v] of Object.entries(ex.request.headers ?? {})) req.set(k, fill(v));
        if (!ex.request.headers?.['Content-Type']) req.set('Content-Type', 'application/xml; charset=utf-8');
        const res = await req.send(fill(ex.request.body));
        const text = res.text ?? '';
        expect(res.status, `${f.file}: ${ex.name}\n${text}`).toBe(ex.response.status);
        if (ex.response.hrefs) {
          const got = hrefsOf(text).filter((x) => !x.startsWith('/dav/principals/'));
          expect(got.sort(), `${f.file}: ${ex.name}`).toEqual(ex.response.hrefs.map(fill).sort());
        }
        for (const a of ex.response.absent ?? []) expect(hrefsOf(text), `${f.file}: ${ex.name}`).not.toContain(fill(a));
        for (const c of ex.response.contains ?? []) expect(text, `${f.file}: ${ex.name}`).toContain(fill(c));
        if (ex.capture === 'token') vars.token = /<d:sync-token>([^<]+)<\/d:sync-token>/.exec(text)![1]!;
      }
    });
  }
});
