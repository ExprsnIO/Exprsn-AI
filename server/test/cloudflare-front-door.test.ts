/*
 * 1.9.99-final, Sprint 61 (B-10901): the Cloudflare front door against `fake-cloudflare.ts` only. DNS and edge TLS
 * (Full strict to the origin) as an alternative to ACME: a name that answered DNS-only with its ACME certificate is
 * switched with no moment without a record or a certificate; CF-Connecting-IP is the client address only from
 * Cloudflare's ranges or the tunnel's connector, and a spoofed header is ignored (and dropped) otherwise; an install
 * without `cloudflare` in TRUST_PROXY reads no Cloudflare header at all. Migration 161 is applied here when missing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { edgeCreateSchema, packCovers, probeOrigin, tunnelCname } from '../src/cloud/edge.js';
import { applyTrustProxy, edgeTrust } from '../src/http/client-address.js';
import { CLOUDFLARE_IP_RANGES, cloudflareRanges } from '../src/http/cloudflare-ips.js';
import { certFor, edgeWorld, tlsOrigin, type EdgeWorld, type Moment } from './cloudflare-edge-helpers.js';
import { TEST_IP_RANGES } from './fake-cloudflare-edge.js';
import { harness, type Harness } from './helpers.js';

const cfg = (TRUST_PROXY: string, CLOUDFLARE_TUNNEL_PEERS = 'loopback', CLOUDFLARE_IP_RANGES = '') => ({ TRUST_PROXY, CLOUDFLARE_TUNNEL_PEERS, CLOUDFLARE_IP_RANGES });

describe('B-10901: the client address behind Cloudflare', () => {
  it('ships Cloudflare\'s ranges as a dated list that is kept current', () => {
    const age = (Date.now() - Date.parse(`${CLOUDFLARE_IP_RANGES.asOf}T00:00:00Z`)) / 86400_000;
    expect(age).toBeLessThan(180);
    expect(cloudflareRanges()).toEqual([...TEST_IP_RANGES.ipv4_cidrs, ...TEST_IP_RANGES.ipv6_cidrs]);
  });

  it('installs nothing without the cloudflare keyword', () => {
    const app = express();
    expect(applyTrustProxy(app, cfg('loopback'))).toBeNull();
    expect(app.get('trust proxy')).toBe('loopback');
    expect(edgeTrust(cfg('uniquelocal'), () => true)).toBeNull();
  });

  it('finds the edge hop only at Cloudflare addresses or the tunnel connector', () => {
    const local = (a: string) => a === '127.0.0.1';
    const t = edgeTrust(cfg('loopback,cloudflare', '10.1.2.3'), local)!;
    expect(t.edgeOf('104.16.0.9', undefined)).toEqual({ via: 'edge', peer: '104.16.0.9' });
    expect(t.edgeOf('::ffff:172.64.1.1', undefined)).toEqual({ via: 'edge', peer: '172.64.1.1' });
    expect(t.edgeOf('2606:4700::6810:1', undefined)).toMatchObject({ via: 'edge' });
    expect(t.edgeOf('10.1.2.3', undefined)).toEqual({ via: 'tunnel', peer: '10.1.2.3' });
    // Through a local proxy (nginx), the hop it saw must be Cloudflare's.
    expect(t.edgeOf('127.0.0.1', '198.51.100.7, 104.16.0.9')).toEqual({ via: 'edge', peer: '104.16.0.9' });
    expect(t.edgeOf('127.0.0.1', '104.16.0.9, 198.51.100.7')).toBeNull();
    // The tunnel connector counts only as the socket's own peer, never as a forwarded hop a client could write.
    expect(t.edgeOf('127.0.0.1', '10.1.2.3')).toBeNull();
    expect(t.edgeOf('8.8.8.8', undefined)).toBeNull();
    expect(t.edgeOf('8.8.8.8', '104.16.0.9')).toBeNull();
    // A newer list replaces the shipped one.
    const custom = edgeTrust(cfg('cloudflare', '192.0.2.1', '203.0.113.0/24'), () => false)!;
    expect(custom.edgeOf('203.0.113.5', undefined)).toMatchObject({ via: 'edge' });
    expect(custom.edgeOf('104.16.0.9', undefined)).toBeNull();
  });

  describe('through the app', () => {
    let plain: Harness;
    let tunnel: Harness;
    let noPeer: Harness;
    const attempts = async (h: Harness, headers: Record<string, string>) => {
      const r = request(h.app).post('/api/auth/login');
      for (const [k, v] of Object.entries(headers)) r.set(k, v);
      await r.send({ username: 'nobody-here', password: 'wrong password' });
      return ((await h.s.db('login_throttle').where('key', 'like', 'ip:%')) as { key: string }[]).map((x) => x.key);
    };

    beforeAll(async () => {
      plain = await harness();
      tunnel = await harness({ TRUST_PROXY: 'loopback,cloudflare', CLOUDFLARE_TUNNEL_PEERS: 'loopback' });
      noPeer = await harness({ TRUST_PROXY: 'cloudflare', CLOUDFLARE_TUNNEL_PEERS: '192.0.2.1' });
    }, 120_000);
    afterAll(async () => {
      await plain.close();
      await tunnel.close();
      await noPeer.close();
    });

    it('reads no Cloudflare header on an install not behind Cloudflare', async () => {
      const keys = await attempts(plain, { 'cf-connecting-ip': '203.0.113.9' });
      expect(keys.some((k) => k.includes('203.0.113.9'))).toBe(false);
      expect(keys.some((k) => k.includes('127.0.0.1'))).toBe(true);
    });

    it('takes CF-Connecting-IP from the tunnel connector', async () => {
      expect(await attempts(tunnel, { 'cf-connecting-ip': '203.0.113.9' })).toContain('ip:203.0.113.9');
    });

    it('ignores a spoofed CF-Connecting-IP from anyone else', async () => {
      const keys = await attempts(noPeer, { 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '104.16.0.9' });
      expect(keys.some((k) => k.includes('203.0.113.9') || k.includes('104.16.0.9'))).toBe(false);
    });

    it('drops the header for later readers when it is not believed', async () => {
      const app = express();
      const edge = applyTrustProxy(app, cfg('cloudflare', '192.0.2.1'))!;
      app.use(edge.middleware);
      app.get('/', (req, res) => void res.json({ ip: req.ip, header: req.headers['cf-connecting-ip'] ?? null, edge: req.edge ?? null }));
      const r = await request(app).get('/').set('cf-connecting-ip', '203.0.113.9');
      expect(r.body).toMatchObject({ header: null, edge: null });
      expect(r.body.ip).not.toBe('203.0.113.9');
    });
  });
});

describe('B-10901: DNS and edge TLS, switched from ACME', () => {
  let w: EdgeWorld;
  const host = 'ai.example.test';
  let origin: Awaited<ReturnType<typeof tlsOrigin>>;
  let originCa = '';

  /** Every moment: the name has a record, and whatever answers has a certificate (the edge's, Full strict, or the origin's ACME one). */
  const neverDark = (timeline: Moment[]) => {
    for (const m of timeline) {
      expect(m.records.length, `${m.op} left ${host} without a record`).toBeGreaterThan(0);
      for (const r of m.records) if (r.proxied) expect({ op: m.op, certActive: m.certActive, ssl: m.ssl }).toEqual({ op: m.op, certActive: true, ssl: 'strict' });
    }
  };

  beforeAll(async () => {
    w = await edgeWorld();
    const c = certFor(host);
    originCa = c.cert;
    origin = await tlsOrigin(c.cert, c.key);
    w.h.s.cloud.edge.options.originCa = originCa;
  }, 180_000);
  afterAll(async () => {
    origin.server.close();
    await w.stop();
  });

  const addRecord = (name: string, type: string, content: string, proxied = false) => {
    const id = Math.random().toString(16).slice(2).padEnd(32, '0').slice(0, 32);
    const zone = [...w.cf.zones.values()][0]!;
    w.cf.records.set(id, { id, zone_id: zone.id, zone_name: zone.name, name, type, content, ttl: 300, proxied, comment: null, tags: [], created_on: '', modified_on: '' });
    return id;
  };

  it('checks the origin certificate the way Full strict does', async () => {
    expect(await probeOrigin('127.0.0.1', origin.port, host, originCa)).toMatchObject({ ok: true });
    expect(await probeOrigin('127.0.0.1', origin.port, 'other.example.test', originCa)).toMatchObject({ ok: false });
    expect(await probeOrigin('127.0.0.1', origin.port, host)).toMatchObject({ ok: false });
    expect(await probeOrigin('169.254.169.254', 443, host)).toMatchObject({ ok: false });
    expect(packCovers(['example.test', '*.example.test'], host)).toBe(true);
    expect(packCovers(['example.test', '*.example.test'], 'a.b.example.test')).toBe(false);
  });

  it('changes nothing while the edge certificate is pending', async () => {
    const recId = addRecord('pending.example.test', 'A', '127.0.0.1');
    w.cf.edge.pendingCertificates.add(w.zoneId);
    const edge = await w.h.s.cloud.edge.create(w.admin, edgeCreateSchema.parse({ name: 'pending', accountId: w.account.id, hostname: 'pending.example.test', zone: 'example.test', origin: { kind: 'public', address: '127.0.0.1', port: origin.port } }));
    const before = w.cf.requests.length;
    await expect(w.h.s.cloud.edge.apply(w.admin, edge.id)).rejects.toMatchObject({ status: 409, extensions: { reason: 'edge_certificate_pending' } });
    expect(w.cf.requests.slice(before).filter((r) => r.method !== 'GET')).toEqual([]);
    expect(w.cf.records.get(recId)).toMatchObject({ proxied: false, content: '127.0.0.1' });
    expect((await w.h.s.cloud.edge.get(edge.id)).state).toBe('failed');
    w.cf.edge.pendingCertificates.delete(w.zoneId);
  });

  it('refuses a public origin whose certificate Full strict would refuse, before any DNS change', async () => {
    addRecord('badcert.example.test', 'A', '127.0.0.1');
    const other = certFor('badcert.example.test');
    const bad = await tlsOrigin(other.cert, other.key);
    try {
      const edge = await w.h.s.cloud.edge.create(w.admin, edgeCreateSchema.parse({ name: 'badcert', accountId: w.account.id, hostname: 'badcert.example.test', zone: 'example.test', origin: { kind: 'public', address: '127.0.0.1', port: bad.port }, waf: { enabled: false } }));
      await expect(w.h.s.cloud.edge.apply(w.admin, edge.id)).rejects.toMatchObject({ status: 409, extensions: { reason: 'origin_certificate' } });
      expect([...w.cf.records.values()].find((r) => r.name === 'badcert.example.test')).toMatchObject({ proxied: false });
    } finally {
      bad.server.close();
    }
  });

  it('switches an ACME name to the front door with a public origin: proxied in place, Full strict, no gap', async () => {
    const recId = addRecord(host, 'A', '127.0.0.1');
    w.cf.watch = host;
    w.cf.timeline.length = 0;
    const edge = await w.h.s.cloud.edge.create(w.admin, edgeCreateSchema.parse({ name: 'main', accountId: w.account.id, hostname: host, zone: 'example.test', origin: { kind: 'public', address: '127.0.0.1', port: origin.port } }));
    const done = await w.h.s.cloud.edge.apply(w.admin, edge.id);
    expect(done).toMatchObject({ state: 'applied', switchedFrom: 'acme', labelCap: 'confidential' });
    expect(done.steps.map((s) => s.step)).toEqual(['zone', 'edge_certificate', 'ssl', 'origin_certificate', 'dns', 'waf']);
    expect(w.cf.edge.settings.get(w.zoneId)).toMatchObject({ ssl: 'strict', min_tls_version: '1.2', always_use_https: 'on' });
    // The same record, now proxied; never deleted and recreated.
    expect(w.cf.records.get(recId)).toMatchObject({ type: 'A', content: '127.0.0.1', proxied: true });
    expect(w.cf.requests.some((r) => r.method === 'DELETE' && r.path.includes('dns_records'))).toBe(false);
    // SSL was strict before the record became proxied.
    const ops = w.cf.requests.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.path}`);
    expect(ops.findIndex((o) => o.endsWith('/settings/ssl'))).toBeLessThan(ops.findIndex((o) => o.includes(`/dns_records/${recId}`)));
    neverDark(w.cf.timeline);
    // Applying again changes no record.
    const n = w.cf.requests.filter((r) => r.path.includes('dns_records') && r.method !== 'GET').length;
    await w.h.s.cloud.edge.apply(w.admin, edge.id);
    expect(w.cf.requests.filter((r) => r.path.includes('dns_records') && r.method !== 'GET').length).toBe(n);
  });

  it('switches an ACME name with two addresses to a tunnel without a moment dark', async () => {
    const name = 'app.example.test';
    addRecord(name, 'A', '192.0.2.10');
    addRecord(name, 'A', '192.0.2.11');
    w.cf.watch = name;
    w.cf.timeline.length = 0;
    const edge = await w.h.s.cloud.edge.create(w.admin, edgeCreateSchema.parse({ name: 'app', accountId: w.account.id, hostname: name, zone: 'example.test', origin: { kind: 'tunnel', service: 'http://127.0.0.1:8080' } }));
    const done = await w.h.s.cloud.edge.apply(w.admin, edge.id);
    expect(done.switchedFrom).toBe('acme');
    const recs = [...w.cf.records.values()].filter((r) => r.name === name);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ type: 'CNAME', content: tunnelCname(done.tunnelId!), proxied: true });
    neverDark(w.cf.timeline);
    // Proxied first (both), then one removed, then the kept one re-pointed.
    const kinds = w.cf.timeline.filter((m) => m.op.includes('dns_records')).map((m) => m.records.map((r) => `${r.type}${r.proxied ? '+' : '-'}`).join(','));
    expect(kinds).toEqual(['A+,A-', 'A+,A+', 'A+', 'CNAME+']);
  });

  it('answers the routes: list, render, ranges compared with the API', async () => {
    const c = w.admin.client;
    const list = await c.agent.get('/api/admin/cloud/edge');
    expect(list.status).toBe(200);
    expect(list.body.ranges.asOf).toBe(CLOUDFLARE_IP_RANGES.asOf);
    expect(list.body.edges.map((e: { name: string }) => e.name)).toEqual(expect.arrayContaining(['main', 'app']));
    // Only the vault reference of a tunnel token is ever answered, never the token.
    for (const t of w.cf.edge.tunnelTokens.values()) expect(JSON.stringify(list.body)).not.toContain(t);
    expect(list.body.edges.find((e: { name: string }) => e.name === 'app').tokenRef).toMatch(/^vault:cloud\/edge\/[0-9a-z]{26}#tunnel_token$/);
    const ranges = await c.agent.get(`/api/admin/cloud/edge/ranges?accountId=${w.account.id}`);
    expect(ranges.body).toMatchObject({ added: [], removed: [] });
    w.cf.edge.ranges = { ...TEST_IP_RANGES, ipv4_cidrs: [...TEST_IP_RANGES.ipv4_cidrs, '192.0.2.0/24'] };
    expect((await c.agent.get(`/api/admin/cloud/edge/ranges?accountId=${w.account.id}`)).body.added).toEqual(['192.0.2.0/24']);
    w.cf.edge.ranges = TEST_IP_RANGES;
    const created = await c.agent.post('/api/admin/cloud/edge').set('x-csrf-token', c.csrf).send({ name: 'viaroute', accountId: w.account.id, hostname: 'x.example.test', zone: 'example.test', origin: { kind: 'tunnel', service: 'http://127.0.0.1:8080' } });
    expect(created.status).toBe(201);
    const bad = await c.agent.post('/api/admin/cloud/edge').set('x-csrf-token', c.csrf).send({ name: 'outside', accountId: w.account.id, hostname: 'x.other.test', zone: 'example.test', origin: { kind: 'tunnel', service: 'http://127.0.0.1:8080' } });
    expect(bad.status).toBe(409);
    const one = await c.agent.get(`/api/admin/cloud/edge/${created.body.edge.id}`);
    expect(one.body.waf.plan).toBe('free');
    expect(one.body.accessExclusions.map((x: { path: string }) => x.path)).toEqual(expect.arrayContaining(['/v1', '/.well-known/acme-challenge']));
    const audit = (await w.h.s.db('audit_events').where('action', 'like', 'cloud.edge.%').select('action')) as { action: string }[];
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(['cloud.edge.created', 'cloud.edge.applied', 'cloud.edge.apply.failed']));
  });
});
