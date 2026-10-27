import { generateKeyPairSync } from 'node:crypto';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { createServer as createTlsServer, type Server as TlsServer } from 'node:tls';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { selfSignedCertificate } from '../src/federation/x509.js';
import { parseSyslogAddress, syslogFrame } from '../src/audit/siem-destinations.js';
import { harness, localUser, loginAdmin, type Client, type Harness } from './helpers.js';

const send = (c: Client, method: 'post' | 'put' | 'patch' | 'delete', url: string, body: object = {}) => c.agent[method](url).set('x-csrf-token', c.csrf).send(body);

/** A certificate for localhost and the PEMs a receiver and a destination need. */
function localhostCert() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const der = selfSignedCertificate({ publicKey: pair.publicKey, privateKey: pair.privateKey, commonName: 'localhost', days: 2 });
  const cert = '-----BEGIN CERTIFICATE-----\n' + der.toString('base64').match(/.{1,64}/g)!.join('\n') + '\n-----END CERTIFICATE-----\n';
  return { key: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), cert };
}

async function until<T>(fn: () => T | Promise<T>, ms = 8000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('B-7501: audit streaming per tenant, under dual control', () => {
  let h: Harness;
  let alice: Client;
  let bob: Client;
  let https: HttpsServer;
  let httpsUrl: string;
  const received: { auth: string | undefined; lines: Record<string, unknown>[] }[] = [];
  let tls: TlsServer;
  let tlsPort: number;
  const frames: string[] = [];
  const pem = localhostCert();

  beforeEach(async () => {
    received.length = 0;
    frames.length = 0;
    https = createHttpsServer({ key: pem.key, cert: pem.cert }, (req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push({ auth: req.headers.authorization, lines: body.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) });
        res.writeHead(200).end();
      });
    });
    await new Promise<void>((r) => https.listen(0, r));
    httpsUrl = `https://localhost:${(https.address() as AddressInfo).port}/ingest`;
    tls = createTlsServer({ key: pem.key, cert: pem.cert }, (s) => {
      let buf = '';
      s.on('data', (d) => (buf += d.toString('utf8')));
      s.on('end', () => {
        // RFC 6587 octet counting: "<len> <msg>" repeated.
        while (buf.length) {
          const m = /^(\d+) /.exec(buf);
          if (!m) break;
          const n = Number(m[1]);
          const start = m[0].length;
          frames.push(Buffer.from(buf, 'utf8').subarray(start, start + n).toString('utf8'));
          buf = Buffer.from(buf, 'utf8').subarray(start + n).toString('utf8');
        }
      });
    });
    await new Promise<void>((r) => tls.listen(0, r));
    tlsPort = (tls.address() as AddressInfo).port;
    h = await harness({ SIEM_TENANT_MAX_DESTINATIONS: '2' });
    await localUser(h, 'alice', ['tenant-admin'], 'confidential');
    alice = await loginAdmin(h, 'alice');
    await localUser(h, 'bob', ['tenant-admin'], 'confidential');
    bob = await loginAdmin(h, 'bob');
  });
  afterEach(async () => {
    await h.close();
    https.close();
    tls.close();
  });

  it('a destination streams only after a second admin approves it, with the bearer token, and shows its counters', async () => {
    const d = (await send(alice, 'post', '/api/admin/audit/siem', { name: 'Splunk', kind: 'https', url: httpsUrl, token: 'hec-secret', caPem: pem.cert, note: 'SOC intake' }).expect(201)).body as { id: string; state: string; hasToken: boolean };
    expect(d).toMatchObject({ state: 'proposed', hasToken: true, hasCa: true, connection: 'disabled' });
    // The token is sealed, never returned.
    const row = await h.s.db('audit_siem_destinations').where({ id: d.id }).first();
    expect(String(row!.token)).not.toContain('hec-secret');
    expect(JSON.stringify((await alice.agent.get('/api/admin/audit/siem').expect(200)).body)).not.toContain('hec-secret');

    // Dual control: the proposer cannot approve; nothing flows while proposed.
    await send(alice, 'post', `/api/admin/audit/siem/${d.id}/approve`).expect(403);
    await h.s.siemDestinations.flush();
    expect(received.length).toBe(0);
    const approved = (await send(bob, 'post', `/api/admin/audit/siem/${d.id}/approve`, { note: 'ok' }).expect(200)).body;
    expect(approved).toMatchObject({ state: 'active', approvedBy: expect.any(String), note: 'ok' });

    // The approval itself is an audit event: it is the first thing delivered.
    await until(async () => {
      await h.s.siemDestinations.flush();
      return received.length > 0;
    });
    expect(received[0]!.auth).toBe('Bearer hec-secret');
    const actions = received.flatMap((r) => r.lines.map((l) => l.action));
    expect(actions).toContain('audit.siem.approved');
    expect(received[0]!.lines[0]).toMatchObject({ source: 'exprsn-ai', tenant_id: h.tenantId });

    // Another tenant's events never reach this destination (a platform-tenant event, here).
    await h.s.audit.append({ tenantId: 'platform', action: 'test.other-tenant', kind: 'system', actor: { service: 'test' } });
    await h.s.audit.append({ tenantId: h.tenantId, action: 'test.mine', kind: 'system', actor: { service: 'test' } });
    await until(async () => {
      await h.s.siemDestinations.flush();
      return received.flatMap((r) => r.lines).some((l) => l.action === 'test.mine');
    });
    expect(received.flatMap((r) => r.lines).some((l) => l.action === 'test.other-tenant')).toBe(false);

    const view = ((await alice.agent.get('/api/admin/audit/siem').expect(200)).body as { destinations: Record<string, unknown>[]; max: number });
    expect(view.max).toBe(2);
    expect(view.destinations[0]).toMatchObject({ id: d.id, state: 'active', connection: 'connected', approvedByName: 'BOB', proposedByName: 'ALICE' });
    expect(Number(view.destinations[0]!.delivered)).toBeGreaterThan(0);

    // Disabling stops the stream; the decision is audited.
    await send(alice, 'post', `/api/admin/audit/siem/${d.id}/disable`, { note: 'retired' }).expect(200);
    const before = received.flatMap((r) => r.lines).length;
    await h.s.audit.append({ tenantId: h.tenantId, action: 'test.after-disable', kind: 'system', actor: { service: 'test' } });
    await h.s.siemDestinations.flush();
    await new Promise((r) => setTimeout(r, 100));
    expect(received.flatMap((r) => r.lines).length).toBe(before);
    const audited = (await h.s.db('audit_events').where({ tenant_id: h.tenantId }).whereIn('action', ['audit.siem.proposed', 'audit.siem.approved', 'audit.siem.disabled'])).map((e) => String(e.action));
    expect(audited).toEqual(expect.arrayContaining(['audit.siem.proposed', 'audit.siem.approved', 'audit.siem.disabled']));
  });

  it('syslog over TLS carries RFC 5424 frames with octet counting; a test event reports the outcome', async () => {
    const d = (await send(alice, 'post', '/api/admin/audit/siem', { name: 'Syslog', kind: 'syslog', url: `localhost:${tlsPort}`, caPem: pem.cert }).expect(201)).body as { id: string };
    expect((await send(alice, 'post', `/api/admin/audit/siem/${d.id}/test`).expect(200)).body).toEqual({ ok: true, error: null });
    await until(() => frames.length > 0);
    expect(frames[0]).toMatch(/^<110>1 \d{4}-\d{2}-\d{2}T\S+ \S+ exprsn-ai - audit\.siem\.test - \{/);
    expect(JSON.parse(frames[0]!.slice(frames[0]!.indexOf('{')))).toMatchObject({ source: 'exprsn-ai', action: 'audit.siem.test', detail: { test: true } });
    expect((await h.s.db('audit_events').where({ tenant_id: h.tenantId, action: 'audit.siem.tested' })).length).toBe(1);

    // A receiver that is down: the test says so, and the row keeps the error.
    const dead = (await send(alice, 'post', '/api/admin/audit/siem', { name: 'Dead', kind: 'syslog', url: 'localhost:1' }).expect(201)).body as { id: string };
    const r = (await send(alice, 'post', `/api/admin/audit/siem/${dead.id}/test`).expect(200)).body as { ok: boolean; error: string };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/.+/);
    // The limit on proposed or active destinations per tenant.
    await send(alice, 'post', '/api/admin/audit/siem', { name: 'Third', kind: 'syslog', url: 'localhost:6514' }).expect(409);
  });

  it('refuses what the address guard refuses, and rejected destinations stay rejected', async () => {
    await send(alice, 'post', '/api/admin/audit/siem', { name: 'Plain', kind: 'https', url: 'http://siem.example.com/' }).expect(400);
    await send(alice, 'post', '/api/admin/audit/siem', { name: 'Meta', kind: 'https', url: 'https://169.254.169.254/latest' }).expect(400);
    await send(alice, 'post', '/api/admin/audit/siem', { name: 'No port', kind: 'syslog', url: 'siem.example.com' }).expect(400);
    const d = (await send(alice, 'post', '/api/admin/audit/siem', { name: 'Maybe', kind: 'https', url: 'https://siem.example.com/hec' }).expect(201)).body as { id: string };
    await send(bob, 'post', `/api/admin/audit/siem/${d.id}/reject`, { note: 'not our SIEM' }).expect(200);
    await send(bob, 'post', `/api/admin/audit/siem/${d.id}/approve`).expect(409);
    await send(alice, 'post', `/api/admin/audit/siem/${d.id}/test`).expect(409);
    // Auditors read the list; only tenant admins change it.
    await localUser(h, 'aud', ['auditor'], 'confidential');
    const aud = await loginAdmin(h, 'aud');
    await aud.agent.get('/api/admin/audit/siem').expect(200);
    await send(aud, 'post', '/api/admin/audit/siem', { name: 'x', kind: 'syslog', url: 'localhost:6514' }).expect(403);
  });

  it('frames and addresses', () => {
    expect(parseSyslogAddress('siem.example.com:6514')).toEqual({ host: 'siem.example.com', port: 6514 });
    expect(parseSyslogAddress('[::1]:6514')).toEqual({ host: '::1', port: 6514 });
    expect(() => parseSyslogAddress('siem.example.com')).toThrow();
    const f = syslogFrame({ id: 'x', tenant_id: 't', seq: 1, ts: Date.UTC(2026, 0, 2, 3, 4, 5), action: 'user.created', kind: 'admin', actor: {}, target: {}, label: 'internal', decision: null, detail: null, trace_id: null, corrects: null, prev_hash: '0', hash: '1' }, 'host1');
    const m = /^(\d+) (.*)$/s.exec(f)!;
    expect(Buffer.byteLength(m[2]!, 'utf8')).toBe(Number(m[1]));
    expect(m[2]).toMatch(/^<110>1 2026-01-02T03:04:05\.000Z host1 exprsn-ai - user\.created - \{"source":"exprsn-ai"/);
  });
});
