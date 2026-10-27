/*
 * 1.9.0, Sprint 54 (B-182): Active Directory as a user store, against the fake domain controller in `fake-ad.ts`
 * (LDAPS or StartTLS with a certificate made here); never the live directory.
 */
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { selfSignedCertificate } from '../src/federation/x509.js';
import { AdProvider, adBindCode, fileTimeToMs, guidToBuffer, guidToString, primaryGroupSid, sidToString, srvOrder, type SrvRecord } from '../src/identity/providers/ad.js';
import { adConfigSchema, type AdConfig, type Step } from '../src/identity/providers/types.js';
import { storeKind, formFor, layoutDrift } from '../src/identity/providers/kinds.js';
import '../src/identity/providers/store-kinds.js';
import { FakeAd, sidBytes } from './fake-ad.js';
import { harness, localUser, loginAdmin, type Client, type Harness } from './helpers.js';

function localhostCert() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const der = selfSignedCertificate({ publicKey: pair.publicKey, privateKey: pair.privateKey, commonName: 'localhost', days: 2 });
  const cert = '-----BEGIN CERTIFICATE-----\n' + der.toString('base64').match(/.{1,64}/g)!.join('\n') + '\n-----END CERTIFICATE-----\n';
  return { key: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), cert };
}

const pem = localhostCert();
const dir = mkdtempSync(path.join(tmpdir(), 'exprsn-ad-'));
const caFile = path.join(dir, 'ca.pem');
writeFileSync(caFile, pem.cert);

/** A FILETIME (100 ns since 1601) for epoch milliseconds. */
const fileTime = (ms: number) => String((BigInt(ms) + 11644473600000n) * 10000n);

const closedPort = async () => {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
};

describe('B-182: Active Directory store', () => {
  let ad: FakeAd;
  // The harness first: it sets the operator's secret reference policy (SECRET_REF_ENV allows LDAP_*).
  let h: Harness;
  let ida: Client;
  let alice: { dn: string; guid: Buffer };
  const cfgFor = (over: Partial<Record<string, unknown>> = {}): AdConfig =>
    adConfigSchema.parse({ domain: ad.domain, urls: [ad.url], caFile, bindDN: `svc-exprsn@${ad.domain}`, bindPassword: 'env:LDAP_AD_BIND_PW', baseDN: ad.base, ...over });
  const provider = (over: Partial<Record<string, unknown>> = {}, srv?: (n: string) => Promise<SrvRecord[]>) => new AdProvider('p1', 'Corp AD', cfgFor(over), undefined, null, srv);

  beforeAll(async () => {
    h = await harness();
    await localUser(h, 'ida', ['identity-admin', 'tenant-admin'], 'restricted');
    ida = await loginAdmin(h, 'ida');
    ad = await new FakeAd('corp.example.com', pem, 'ldaps').start();
    process.env.LDAP_AD_BIND_PW = ad.bindPassword;
    alice = ad.addUser({ sam: 'alice', password: 'Alice-pass-1', displayName: 'Alice Ng', mail: 'alice@corp.example.com' });
    ad.addUser({ sam: 'dora', password: 'Dora-pass-1', userAccountControl: 0x202 });
    ad.addUser({ sam: 'lou', password: 'Lou-pass-1', lockoutTime: fileTime(Date.now() - 60_000) });
    ad.addUser({ sam: 'cal', password: 'Cal-pass-1', computed: 0x10 });
    ad.addUser({ sam: 'max', password: 'Max-pass-1', pwdLastSet: '0' });
    ad.addUser({ sam: 'pat', password: 'Pat-pass-1', passwordExpiry: fileTime(Date.now() - 3600_000) });
    ad.addUser({ sam: 'eve', password: 'Eve-pass-1', accountExpires: fileTime(Date.now() - 3600_000) });
    const eng = ad.addGroup('Engineers', [alice.dn]);
    const staff = ad.addGroup('Staff All', [eng]);
    ad.addGroup('Everyone', [staff]);
    ad.addGroup('Unrelated', [ad.userDn('dora')]);
  });
  afterAll(async () => {
    await ad.stop();
    await h.close();
  });

  it('turns objectGUID bytes into GUID text and back, and reads AD times and bind codes', () => {
    const bytes = Buffer.from('67452301ab89efcd0123456789abcdef', 'hex');
    expect(guidToString(bytes)).toBe('01234567-89ab-cdef-0123-456789abcdef');
    expect(guidToBuffer('{01234567-89AB-CDEF-0123-456789ABCDEF}')!.equals(bytes)).toBe(true);
    expect(guidToBuffer('not-a-guid')).toBeNull();
    expect(fileTimeToMs('0')).toBeNull();
    expect(fileTimeToMs('9223372036854775807')).toBeNull();
    expect(fileTimeToMs(fileTime(1_700_000_000_000))).toBe(1_700_000_000_000);
    expect(adBindCode('80090308: LdapErr: DSID-0C09044E, comment: AcceptSecurityContext error, data 775, v4563')).toBe('775');
  });

  it('signs in by sAMAccountName, DOMAIN\\name and userPrincipalName, linked by objectGUID', async () => {
    const p = provider();
    for (const name of ['alice', 'CORP\\alice', 'alice@corp.example.com', 'ALICE']) {
      const r = await p.authenticate(name, 'Alice-pass-1');
      expect(r.status, name).toBe('ok');
      if (r.status !== 'ok') continue;
      expect(r.user.externalId).toBe(guidToString(alice.guid));
      expect(r.user.username).toBe('alice');
      expect(r.user.displayName).toBe('Alice Ng');
      expect(r.user.email).toBe('alice@corp.example.com');
    }
    expect((await p.authenticate('alice', 'wrong')).status).toBe('invalid');
    expect((await p.authenticate('alice', '')).status).toBe('invalid');
    expect((await p.authenticate('nobody', 'x')).status).toBe('not_found');
    // only one attribute when the store says so
    expect((await provider({ signInAttribute: 'sAMAccountName' }).authenticate('alice@corp.example.com', 'Alice-pass-1')).status).toBe('not_found');
    expect((await provider({ signInAttribute: 'userPrincipalName' }).authenticate('alice', 'Alice-pass-1')).status).toBe('ok'); // @domain added
    const upn = await provider({ usernameFrom: 'userPrincipalName' }).authenticate('alice', 'Alice-pass-1');
    expect(upn.status === 'ok' && upn.user.username).toBe('alice@corp.example.com');
    // a filter value is escaped, never interpreted
    expect((await p.authenticate('*', 'Alice-pass-1')).status).toBe('not_found');
  });

  it('reads nested groups through LDAP_MATCHING_RULE_IN_CHAIN, and only direct ones when nesting is off', async () => {
    const r = await provider().authenticate('alice', 'Alice-pass-1');
    expect(r.status === 'ok' && r.user.groups.sort()).toEqual([ad.groupDn('Engineers'), ad.groupDn('Everyone'), ad.groupDn('Staff All')].sort());
    const cn = await provider({ groupNameAttribute: 'cn' }).authenticate('alice', 'Alice-pass-1');
    expect(cn.status === 'ok' && cn.user.groups.sort()).toEqual(['Engineers', 'Everyone', 'Staff All']);
    const direct = await provider({ nestedGroups: false, groupNameAttribute: 'cn' }).authenticate('alice', 'Alice-pass-1');
    expect(direct.status === 'ok' && direct.user.groups).toEqual(['Engineers']);
  });

  it('refuses disabled, locked and expired accounts before any password is tried, and must-change and expired passwords after', async () => {
    const p = provider();
    const cases: [string, string, string][] = [
      ['dora', 'Dora-pass-1', 'disabled'],
      ['lou', 'Lou-pass-1', 'locked'],
      ['cal', 'Cal-pass-1', 'locked'],
      ['eve', 'Eve-pass-1', 'account_expired']
    ];
    for (const [sam, pw, reason] of cases) {
      ad.binds.length = 0;
      const steps: Step[] = [];
      const r = await p.authenticate(sam, pw, steps);
      expect(r, sam).toEqual({ status: 'disabled', reason });
      // the password never reached the directory
      expect(ad.binds.some((b) => b.toLowerCase() === ad.userDn(sam).toLowerCase())).toBe(false);
      expect(steps.some((s) => s.title === 'Account state' && !s.ok)).toBe(true);
    }
    // must change at next logon: the bind says 773 after the right password; a wrong one is just wrong
    expect(await p.authenticate('max', 'Max-pass-1')).toEqual({ status: 'disabled', reason: 'must_change' });
    expect((await p.authenticate('max', 'nope')).status).toBe('invalid');
    expect(await p.authenticate('pat', 'Pat-pass-1')).toEqual({ status: 'disabled', reason: 'password_expired' });
    // directory sync: a disabled or expired account reads as gone, a locked one is still there
    expect(await p.lookup('dora')).toBeNull();
    expect(await p.lookup('eve')).toBeNull();
    expect((await p.lookup('lou'))?.username).toBe('lou');
  });

  it('reads groups page by page with the paged results control, capped at maxGroups', async () => {
    const many = ad.addUser({ sam: 'gina', password: 'Gina-pass-1' });
    for (let i = 0; i < 25; i++) ad.addGroup(`Team ${String(i).padStart(2, '0')}`, [many.dn]);
    ad.pagesServed.length = 0;
    const r = await provider({ pageSize: 10, groupNameAttribute: 'cn' }).authenticate('gina', 'Gina-pass-1');
    expect(r.status === 'ok' && r.user.groups.length).toBe(25);
    expect(ad.pagesServed).toEqual([10, 10, 5]);
    expect(ad.searches.filter((s) => s.paged === 10).length).toBe(3);
    const capped = await provider({ pageSize: 10, maxGroups: 12 }).authenticate('gina', 'Gina-pass-1');
    expect(capped.status === 'ok' && capped.user.groups.length).toBe(12);
  });

  it('looks an account up by objectGUID, so a renamed account stays the same account', async () => {
    const bob = ad.addUser({ sam: 'bob', password: 'Bob-pass-1' });
    const p = provider();
    const before = await p.lookup('bob');
    expect(before?.externalId).toBe(guidToString(bob.guid));
    ad.rename('bob', 'robert');
    expect(await p.lookup('bob')).toBeNull();
    const byId = await p.lookupById(guidToString(bob.guid));
    expect(byId?.username).toBe('robert');
    expect(byId?.externalId).toBe(before?.externalId);
    expect(await p.lookupById('00000000-0000-0000-0000-000000000000')).toBeNull();
    expect(await p.lookupById('not a guid')).toBeNull();
  });

  it('requires LDAPS or StartTLS with a verified certificate', async () => {
    // plain ldap:// without StartTLS: refused by the schema and by the provider, in development too
    expect(() => adConfigSchema.parse({ domain: 'corp.example.com', urls: ['ldap://dc1.corp.example.com'], bindDN: 'x', bindPassword: 'env:LDAP_AD_BIND_PW', baseDN: 'DC=corp' })).toThrow(/StartTLS/);
    expect(() => new AdProvider('p', 'AD', { ...cfgFor(), urls: ['ldap://localhost:389'], startTLS: false } as AdConfig)).toThrow(/StartTLS/);
    expect(adConfigSchema.safeParse({ domain: 'corp.example.com', urls: ['ldap://dc1.corp.example.com'], startTLS: true, bindDN: 'x', bindPassword: 'env:LDAP_AD_BIND_PW', baseDN: 'DC=corp' }).success).toBe(true);
    // a certificate nobody trusts is refused
    const untrusted = await provider({ caFile: undefined }).authenticate('alice', 'Alice-pass-1');
    expect(untrusted.status).toBe('error');
    // StartTLS on ldap://
    const st = await new FakeAd('corp.example.com', pem, 'starttls').start();
    try {
      st.addUser({ sam: 'sam', password: 'Sam-pass-1' });
      const p = new AdProvider('p2', 'AD StartTLS', adConfigSchema.parse({ domain: st.domain, urls: [st.url], startTLS: true, caFile, bindDN: st.bindDN, bindPassword: 'env:LDAP_AD_ST_PW', baseDN: st.base }));
      process.env.LDAP_AD_ST_PW = st.bindPassword;
      const r = await p.authenticate('sam', 'Sam-pass-1');
      expect(r.status).toBe('ok');
      expect(st.startTlsCount).toBeGreaterThan(0);
      // the bind password only ever went over TLS: without StartTLS the fake would see a plain bind first
      expect(st.binds.length).toBeGreaterThan(0);
    } finally {
      await st.stop();
    }
  });

  it('finds domain controllers from SRV records, a site first, and fails over to the next one', async () => {
    const st = await new FakeAd('corp.example.com', pem, 'starttls').start();
    try {
      st.addUser({ sam: 'sri', password: 'Sri-pass-1' });
      process.env.LDAP_AD_SRV_PW = st.bindPassword;
      const dead = await closedPort();
      const asked: string[] = [];
      const srv = async (name: string): Promise<SrvRecord[]> => {
        asked.push(name);
        if (name === '_ldap._tcp.HQ._sites.corp.example.com') return [];
        if (name === '_ldap._tcp.corp.example.com') return [{ name: 'localhost', port: st.port, priority: 10, weight: 0 }, { name: '127.0.0.1', port: dead, priority: 0, weight: 100 }];
        return [];
      };
      const p = new AdProvider('p3', 'AD SRV', adConfigSchema.parse({ domain: 'corp.example.com', site: 'HQ', startTLS: true, caFile, bindDN: st.bindDN, bindPassword: 'env:LDAP_AD_SRV_PW', baseDN: st.base }), undefined, null, srv);
      const steps: Step[] = [];
      expect(await p.test(steps)).toBe(true);
      expect(asked).toEqual(['_ldap._tcp.HQ._sites.corp.example.com', '_ldap._tcp.corp.example.com']);
      expect(await p.candidates()).toEqual([`ldap://localhost:${st.port}`, `ldap://127.0.0.1:${dead}`]); // the one that answered first now
      expect(steps.find((s) => s.title === 'Domain controller')?.detail).toBe(`localhost:${st.port}`);
      expect((await p.authenticate('sri', 'Sri-pass-1')).status).toBe('ok');
      // the Global Catalog: _gc._tcp
      const gc: string[] = [];
      const p2 = new AdProvider('p4', 'AD GC', adConfigSchema.parse({ domain: 'example.com', globalCatalog: true, bindDN: 'x', bindPassword: 'env:LDAP_AD_SRV_PW', baseDN: 'DC=example,DC=com' }), undefined, null, async (n) => (gc.push(n), [{ name: 'gc1.example.com', port: 3268, priority: 0, weight: 0 }]));
      expect(await p2.candidates()).toEqual(['ldaps://gc1.example.com:3269']);
      expect(gc).toEqual(['_gc._tcp.example.com']);
    } finally {
      await st.stop();
    }
  });

  // ---------- QA-1 (1.9.9-qa): the Sprint 54 leftovers ----------

  describe('QA-1: the primary group, memberOf range retrieval and weighted SRV order', () => {
    let pg: FakeAd;
    const pgProvider = (over: Partial<Record<string, unknown>> = {}) =>
      new AdProvider('pg', 'AD primary', adConfigSchema.parse({ domain: pg.domain, urls: [pg.url], caFile, bindDN: pg.bindDN, bindPassword: 'env:LDAP_AD_PG_PW', baseDN: `OU=Staff,${pg.base}`, groupBase: pg.base, ...over }));
    beforeAll(async () => {
      pg = await new FakeAd('corp.example.com', pem, 'ldaps').start();
      process.env.LDAP_AD_PG_PW = pg.bindPassword;
      // Domain Users lives in CN=Users, outside the store's search base, and lists nobody in member.
      pg.addGroup('Domain Users', [], { rid: 513, dn: `CN=Domain Users,CN=Users,${pg.base}` });
      pg.addGroup('Contractors', [], { rid: 1501 });
      const pia = pg.addUser({ sam: 'pia', password: 'Pia-pass-1' });
      pg.addGroup('Eng', [pia.dn]);
      pg.addUser({ sam: 'cora', password: 'Cora-pass-1', primaryGroupID: 1501 });
      pg.addUser({ sam: 'odd', password: 'Odd-pass-1', primaryGroupID: 9999 });
      const ria = pg.addUser({ sam: 'ria', password: 'Ria-pass-1' });
      for (let i = 0; i < 25; i++) pg.addGroup(`Big ${String(i).padStart(2, '0')}`, [ria.dn]);
    });
    afterAll(async () => {
      await pg.stop();
    });

    it('turns a binary SID into text and finds the primary group\'s SID from the account\'s', () => {
      const user = sidBytes([21, 1, 2, 3, 1104]);
      expect(sidToString(user)).toBe('S-1-5-21-1-2-3-1104');
      expect(sidToString(primaryGroupSid(user, 513)!)).toBe('S-1-5-21-1-2-3-513');
      expect(sidToString(Buffer.from([1, 4, 0]))).toBeNull();
      expect(primaryGroupSid(sidBytes([21]), 513)).toBeNull(); // no domain part
      expect(primaryGroupSid(user, -1)).toBeNull();
    });

    it('maps the primary group (Domain Users) like any group, nested or not, and only when asked', async () => {
      const steps: Step[] = [];
      const nested = await pgProvider().authenticate('pia', 'Pia-pass-1', steps);
      expect(nested.status === 'ok' && nested.user.groups.sort()).toEqual([`CN=Domain Users,CN=Users,${pg.base}`, pg.groupDn('Eng')].sort());
      expect(steps.find((s) => s.title.startsWith('Resolve the primary group'))?.title).toContain(`S-1-5-21-${pg.domainSid.slice(1).join('-')}-513`);
      const direct = await pgProvider({ nestedGroups: false, groupNameAttribute: 'cn' }).authenticate('pia', 'Pia-pass-1');
      expect(direct.status === 'ok' && direct.user.groups.sort()).toEqual(['Domain Users', 'Eng']);
      const other = await pgProvider({ groupNameAttribute: 'cn' }).lookup('cora');
      expect(other?.groups).toEqual(['Contractors']);
      const off = await pgProvider({ primaryGroup: false, groupNameAttribute: 'cn' }).authenticate('pia', 'Pia-pass-1');
      expect(off.status === 'ok' && off.user.groups).toEqual(['Eng']);
      // a primaryGroupID with no group behind it adds nothing and is not a failure
      const odd = await pgProvider().authenticate('odd', 'Odd-pass-1');
      expect(odd.status === 'ok' && odd.user.groups).toEqual([]);
      // and the store's form offers the option
      expect(formFor(storeKind('ad')!).flatMap((x) => x.fields).find((f) => f.key === 'primaryGroup')?.type).toBe('boolean');
    });

    it('reads a large memberOf by range retrieval when nesting is off, capped at maxGroups', async () => {
      pg.maxValRange = 10;
      try {
        pg.rangeAsks.length = 0;
        const steps: Step[] = [];
        const r = await pgProvider({ nestedGroups: false, groupNameAttribute: 'cn' }).authenticate('ria', 'Ria-pass-1', steps);
        expect(r.status, JSON.stringify(steps)).toBe('ok');
        const groups = r.status === 'ok' ? r.user.groups : [];
        expect(groups).toHaveLength(26); // 25 and Domain Users
        expect(groups).toEqual(expect.arrayContaining(['Domain Users', 'Big 00', 'Big 13', 'Big 24']));
        expect(pg.rangeAsks).toEqual(['memberOf;range=10-*', 'memberOf;range=20-*']);
        expect(steps.find((x) => x.title.startsWith('Read memberOf by range'))?.detail).toBe('25 values in 3 ranges');
        pg.rangeAsks.length = 0;
        const capped = await pgProvider({ nestedGroups: false, maxGroups: 12 }).lookup('ria');
        expect(capped?.groups).toHaveLength(12);
        expect(pg.rangeAsks).toEqual(['memberOf;range=10-*']);
      } finally {
        pg.maxValRange = Infinity;
      }
    });

    it('orders SRV records by priority, then weighted-random within one (RFC 2782)', async () => {
      // a seeded generator, so the distribution is the same on every run
      let seed = 0x2f6b;
      const rand = () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const recs = [
        { name: 'a', port: 636, priority: 0, weight: 60 },
        { name: 'b', port: 636, priority: 0, weight: 30 },
        { name: 'c', port: 636, priority: 0, weight: 10 },
        { name: 'z', port: 636, priority: 0, weight: 0 },
        { name: 'backup', port: 636, priority: 5, weight: 100 }
      ];
      const first: Record<string, number> = {};
      const n = 20_000;
      for (let i = 0; i < n; i++) {
        const order = srvOrder(recs, rand).map((r) => r.name);
        expect(order).toHaveLength(5);
        expect(order[4]).toBe('backup'); // a higher priority number only after every lower one
        first[order[0]!] = (first[order[0]!] ?? 0) + 1;
      }
      expect(first.a! / n).toBeGreaterThan(0.56);
      expect(first.a! / n).toBeLessThan(0.64);
      expect(first.b! / n).toBeGreaterThan(0.27);
      expect(first.b! / n).toBeLessThan(0.33);
      expect(first.c! / n).toBeGreaterThan(0.08);
      expect(first.c! / n).toBeLessThan(0.12);
      // weight 0: chosen first only on a draw of 0 (1 in 101)
      expect((first.z ?? 0) / n).toBeLessThan(0.02);
      // the provider draws again every time (the records are cached, not the order); a "." target is skipped
      let draws = 0;
      const srv = async (): Promise<SrvRecord[]> => (draws++, [{ name: 'dc1.corp.example.com', port: 389, priority: 0, weight: 1 }, { name: 'dc2.corp.example.com', port: 389, priority: 0, weight: 1 }, { name: '.', port: 0, priority: 0, weight: 50 }]);
      let next = 0;
      const p = new AdProvider('w', 'AD weights', adConfigSchema.parse({ domain: 'corp.example.com', bindDN: 'x', bindPassword: 'env:LDAP_AD_PG_PW', baseDN: 'DC=corp,DC=example,DC=com' }), undefined, null, srv, () => next);
      next = 0;
      expect(await p.candidates()).toEqual(['ldaps://dc1.corp.example.com:636', 'ldaps://dc2.corp.example.com:636']);
      next = 0.99;
      expect(await p.candidates()).toEqual(['ldaps://dc2.corp.example.com:636', 'ldaps://dc1.corp.example.com:636']);
      expect(draws).toBe(1);
    });
  });

  it('is in the kind registry with a form that matches its schema and presets that parse', () => {
    const def = storeKind('ad')!;
    expect(def.signIn).toBe('password');
    expect(layoutDrift(def)).toEqual([]);
    const fields = formFor(def).flatMap((s) => s.fields);
    expect(fields.find((f) => f.key === 'bindPassword')?.type).toBe('secret');
    expect(fields.find((f) => f.key === 'signInAttribute')?.options).toEqual(['either', 'sAMAccountName', 'userPrincipalName']);
    for (const preset of def.presets!) expect(adConfigSchema.safeParse(preset.config).success, preset.id).toBe(true);
  });

  describe('through the API: sign-in, words for a password that must change, and sync by objectGUID', () => {
    let storeId: string;
    const send = (method: 'post' | 'patch', url: string, body: object) => ida.agent[method](url).set('x-csrf-token', ida.csrf).send(body);

    it('creates the store, signs alice in with her mapped roles, and tells max in words', async () => {
      const created = await send('post', '/api/admin/identity-providers', { name: 'Corp AD', kind: 'ad', config: { domain: ad.domain, urls: [ad.url], caFile, bindDN: `svc-exprsn@${ad.domain}`, bindPassword: 'env:LDAP_AD_BIND_PW', baseDN: ad.base } });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      storeId = created.body.id;
      const plain = await send('post', '/api/admin/identity-providers', { name: 'Plain AD', kind: 'ad', config: { domain: ad.domain, urls: ['ldap://localhost:389'], bindDN: 'x', bindPassword: 'env:LDAP_AD_BIND_PW', baseDN: ad.base } });
      expect(plain.status).toBe(400);
      expect(JSON.stringify(plain.body)).toContain('StartTLS');
      const tested = await send('post', `/api/admin/identity-providers/${storeId}/test`, {});
      expect(tested.body.ok, JSON.stringify(tested.body)).toBe(true);
      await send('post', '/api/admin/group-mappings', { providerId: storeId, group: ad.groupDn('Everyone'), role: 'member', clearance: 'internal' }).expect(201);
      await send('post', '/api/admin/group-mappings', { providerId: storeId, group: ad.groupDn('Engineers'), role: 'knowledge-curator', clearance: 'internal' }).expect(201);

      const { default: request } = await import('supertest');
      const agent = request.agent(h.app);
      const ok = await agent.post('/api/auth/login').send({ username: 'CORP\\alice', password: 'Alice-pass-1' });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      const me = (await agent.get('/api/me').expect(200)).body;
      expect(me.user.username).toBe('alice');
      expect(me.roles.map((r: { id: string }) => r.id).sort()).toEqual(['knowledge-curator', 'member']);
      const user = (await h.s.users.byUsername(h.tenantId, 'alice'))!;
      expect((await h.s.users.identitiesFor(user.id)).find((i) => i.provider_id === storeId)?.external_id).toBe(guidToString(alice.guid));

      const max = await request(h.app).post('/api/auth/login').send({ username: 'max', password: 'Max-pass-1' });
      expect(max.status).toBe(403);
      expect(max.body.reason).toBe('must_change');
      expect(max.body.detail).toMatch(/must be changed/);
      // a locked account gets the same answer as a wrong password; the audit has the reason
      const lou = await request(h.app).post('/api/auth/login').send({ username: 'lou', password: 'Lou-pass-1' });
      expect(lou.status).toBe(401);
      const failed = await h.s.audit.list(h.tenantId, { action: 'auth.login.failed' });
      expect(failed.some((e) => JSON.stringify(e).includes('"refusal":"locked"'))).toBe(true);
    });

    it('keeps a renamed account linked at sync, and disables one disabled in AD', async () => {
      const row = (await h.s.providers.get(h.tenantId, storeId))!;
      ad.rename('alice', 'alice.ng');
      let report = await h.s.sync.syncProvider(row);
      expect(report.disabled).toEqual([]);
      expect((await h.s.users.byUsername(h.tenantId, 'alice'))!.state).toBe('active');
      ad.set('alice.ng', 'userAccountControl', String(0x202));
      report = await h.s.sync.syncProvider(row);
      expect(report.disabled.map((d) => d.username)).toEqual(['alice']);
      expect((await h.s.users.byUsername(h.tenantId, 'alice'))!.state).toBe('disabled');
    });
  });
});
