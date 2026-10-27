import { createServer, type Server } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPrincipal } from '../src/http/middleware.js';
import { parsePorts, DEFAULT_PORTS, MAX_PORTS } from '../src/platform/netdiag.js';
import { harness, type Harness } from './helpers.js';
import { client } from './retrieval-seed.js';

type Client = Awaited<ReturnType<typeof client>>;

const listen = (): Promise<{ server: Server; port: number }> =>
  new Promise((resolve) => {
    const server = createServer((sock) => sock.end('hello from the test\r\n'));
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port }));
  });

describe('parsePorts (migration 053)', () => {
  it('reads a list, a range and the default set, de-duplicated and sorted', () => {
    expect(parsePorts(undefined)).toEqual(DEFAULT_PORTS);
    expect(parsePorts('22,80,443')).toEqual([22, 80, 443]);
    expect(parsePorts('443,22,22,80')).toEqual([22, 80, 443]);
    expect(parsePorts('8000-8003')).toEqual([8000, 8001, 8002, 8003]);
    expect(parsePorts([22, '80', '8000-8001'])).toEqual([22, 80, 8000, 8001]);
  });
  it('refuses out-of-range ports, bad ranges and too many ports', () => {
    expect(() => parsePorts('0')).toThrow(/between 1 and 65535/);
    expect(() => parsePorts('70000')).toThrow(/between 1 and 65535/);
    expect(() => parsePorts('100-10')).toThrow(/not a port range/);
    expect(() => parsePorts('x')).toThrow(/not a port/);
    expect(() => parsePorts(`1-${MAX_PORTS + 2}`)).toThrow(new RegExp(`more than ${MAX_PORTS}`));
  });
});

describe('The network diagnostic built-in tools (migration 053)', () => {
  let h: Harness;

  // 127.0.0.1 is admitted for the tools only because the operator names it; a tenant list could not.
  beforeEach(async () => {
    h = await harness({ OLLAMA_POLL_MS: '600000', SERVICE_ALLOWED_HOSTS: '127.0.0.1' });
  });
  afterEach(async () => {
    await h.close();
  });

  const caller = async (c: Client) => {
    const p = (await loadPrincipal(h.s, h.tenantId, c.user.id, {}))!;
    return async (name: string, args: Record<string, unknown>, approved = true) => {
      const { tools } = await h.s.tools.resolve({ ...p, mfa: true }, [name], 'internal');
      return h.s.tools.call({ principal: { ...p, mfa: true }, label: 'internal', approved, source: { kind: 'agent-run', id: 'R1' } }, tools[0]!, args);
    };
  };

  it('are seeded as read-only platform tools', async () => {
    const rows = (await h.s.db('registry_entries').where({ impl: 'builtin' }).whereIn('name', ['dns.lookup', 'whois.lookup', 'net.scan']).orderBy('name')) as { name: string; side_effect: string; status: string }[];
    expect(rows.map((r) => [r.name, r.side_effect, r.status])).toEqual([
      ['dns.lookup', 'read', 'published'],
      ['net.scan', 'read', 'published'],
      ['whois.lookup', 'read', 'published']
    ]);
  });

  it('net.scan finds an open port and reports a closed one on an allowed host, and audits the scan', async () => {
    const { server, port } = await listen();
    try {
      const member = await client(h, 'mia', ['member'], 'internal');
      const call = await caller(member);
      // A port that nothing listens on: the OS refuses the connection.
      const shut = await listen();
      const closedPort = shut.port;
      await new Promise<void>((r) => shut.server.close(() => r()));

      const out = (await call('net.scan', { host: '127.0.0.1', ports: [port, closedPort], banner: true })).result as {
        host: string;
        address: string;
        open: number[];
        scanned: number;
        ports: { port: number; state: string; banner?: string }[];
        summary: string;
      };
      expect(out.address).toBe('127.0.0.1');
      expect(out.scanned).toBe(2);
      expect(out.open).toEqual([port]);
      expect(out.ports[0]).toMatchObject({ port, state: 'open', banner: 'hello from the test' });
      expect(out.ports.find((x) => x.port === closedPort)?.state).toBe('closed');
      expect(out.summary).toMatch(/1 of 2 ports open/);

      const audited = (await h.s.db('audit_events').where({ action: 'net.scan.ran' }).orderBy('seq', 'desc').first()) as { detail: string; target: string };
      expect(JSON.parse(audited.target)).toMatchObject({ host: '127.0.0.1' });
      expect(JSON.parse(audited.detail)).toMatchObject({ address: '127.0.0.1', ports: 2, open: 1, via: 'tool' });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('net.scan refuses a public host that the tenant has not allowed, and an internal address the operator has not named', async () => {
    const member = await client(h, 'mia', ['member'], 'internal');
    const call = await caller(member);
    expect((await call('net.scan', { host: '198.51.100.23', ports: [80] })).error).toMatch(/not on this tenant's list of allowed hosts.*Registry, Allowed hosts/s);
    expect((await call('net.scan', { host: '10.1.2.3', ports: [80] })).error).toMatch(/internal address/);
    expect((await call('net.scan', { host: '169.254.169.254', ports: [80] })).error).toMatch(/metadata address/);
  });
});
