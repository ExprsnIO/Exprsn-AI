import type * as dnsModule from 'node:dns';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetch } from 'undici';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Principal } from '../src/authz/policy.js';
import { loadPrincipal } from '../src/http/middleware.js';
import { HttpSafety } from '../src/images/safety.js';
import { addressProblem, checkHost, checkUrl, guardedAgent, isNeverAddress, parseAllowList } from '../src/mcp/hosts.js';
import { HttpAcmeClient } from '../src/ops/acme.js';
import { S3BlobStore } from '../src/platform/blob.js';
import {
  checkServiceHost,
  checkServiceUrl,
  CLOUD_PROVIDER_HOSTS,
  cloudAddressProblem,
  guardedHttp2Connect,
  guardedRequest,
  isPublicAddress,
  literalProblem,
  metadataSafeAgent,
  metadataSafeFetch,
  serviceAddressProblem,
  serviceAgent,
  servicePolicy,
  toolAddressProblem
} from '../src/platform/egress.js';
import { OpenBaoKms } from '../src/platform/kms.js';
import { embeddedV4, isMetadataAddress, isMetadataHost, METADATA_HOSTS, METADATA_V4, METADATA_V6 } from '../src/platform/metadata.js';
import { pushAddressProblem } from '../src/push/model.js';
import { internalRequest, type HttpStepNet } from '../src/workflows/http.js';
import { KubeClient } from '../src/zones/kube.js';
import { harness, type Harness } from './helpers.js';
import { FakeOllama } from './fake-ollama.js';
import { client, seedRetrieval } from './retrieval-seed.js';

/*
 * 1.9.99-final, Sprint 59 (B-10705): every outbound path refuses the cloud instance metadata endpoints, each address
 * (and its IPv6 spellings) and each name, even when an operator's or a tenant's allow-list names it, and a normal
 * name that resolves to one is refused at connect time. Done when (backlog): "A workflow HTTP step, an MCP server or
 * a webhook pointed at the metadata address is refused". Names under `.metadata-test` resolve by plan through the
 * `node:dns` stand-in (the sprint17 pattern); the workflow step's own stand-in is `HttpStepNet`. Nothing here leaves
 * 127.0.0.1.
 */

vi.setConfig({ testTimeout: 60_000, hookTimeout: 90_000 });

const dnsPlan = vi.hoisted(() => new Map<string, string[]>());
vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof dnsModule>();
  type Cb = (err: NodeJS.ErrnoException | null, address: unknown, family?: number) => void;
  const lookup = (host: string, opts: unknown, cb?: Cb) => {
    const callback = (typeof opts === 'function' ? opts : cb) as Cb;
    const plan = dnsPlan.get(host);
    if (!plan) return (actual.lookup as unknown as (h: string, o: unknown, c: Cb) => void)(host, typeof opts === 'function' ? {} : opts, callback);
    const list = plan.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    const all = typeof opts === 'object' && opts !== null && (opts as { all?: boolean }).all;
    queueMicrotask(() => callback(null, all ? list : list[0]!.address, list[0]!.family));
  };
  return { ...actual, lookup, default: { ...actual, lookup } };
});

/** Every metadata address, plus IPv6 spellings of IPv4 ones (mapped dotted and hex, NAT64). */
const ADDRESSES = [...METADATA_V4, ...METADATA_V6, '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', '64:ff9b::a9fe:a9fe', '::ffff:a83f:8110'];
const NAMES = [...METADATA_HOSTS, 'metadata.google.internal.', 'computemetadata.metadata.google.internal'];
const urlOf = (host: string, path = '/latest/meta-data/') => `http://${host.includes(':') ? `[${host}]` : host}${path}`;
const REBIND = 'rebind.metadata-test';
/** An allow-list that names every metadata address, network and name (and the rebinding name): none of it may count. */
const ALLOW = [...ADDRESSES.filter((a) => !a.includes('::ffff') && !a.startsWith('64:')), ...NAMES.filter((n) => !n.endsWith('.')), REBIND, '169.254.0.0/16', '168.63.0.0/16', '100.64.0.0/10', '192.0.0.0/24', 'fd00::/8', 'fd20::/16'].join(',');
const allow = parseAllowList(ALLOW);
const policy = servicePolicy({ SERVICE_ALLOWED_HOSTS: ALLOW });

const rebindTo = (address: string) => dnsPlan.set(REBIND, [address]);

let site: Server;
let siteUrl = '';
beforeAll(async () => {
  site = createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'));
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', () => r()));
  siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => site.close(() => r()));
});

describe('the metadata set', () => {
  it('knows every address in every spelling, and every name', () => {
    for (const a of ADDRESSES) expect(isMetadataAddress(a), a).toBe(true);
    for (const a of ADDRESSES) expect(isMetadataAddress(`[${a}]`), a).toBe(true);
    expect(isMetadataAddress('fd00:0ec2:0000:0000:0000:0000:0000:0254')).toBe(true);
    expect(embeddedV4('64:ff9b::a9fe:a9fe')).toBe('169.254.169.254');
    expect(embeddedV4('2002:a9fe:a9fe::1')).toBe('169.254.169.254');
    expect(embeddedV4('::ffff:0:a9fe:a9fe')).toBe('169.254.169.254');
    for (const n of NAMES) expect(isMetadataHost(n), n).toBe(true);
    expect(isMetadataHost('METADATA.Google.Internal')).toBe(true);
    // Neighbours are not metadata (they keep the rules they had).
    for (const a of ['169.254.10.1', '169.254.169.1', '10.0.0.1', '8.8.8.8', 'fd00::1', 'fd00:ec2::1', '::1', '::', '127.0.0.1']) expect(isMetadataAddress(a), a).toBe(false);
    for (const n of ['metadata.example.com', 'my-metadata', 'google.internal', 'instance-data.example']) expect(isMetadataHost(n), n).toBe(false);
    // The WHATWG parser turns the other IPv4 spellings into dotted decimal before any check.
    for (const u of ['http://2852039166/', 'http://0xa9fea9fe/', 'http://0251.0376.0251.0376/', 'http://169.254.43518/']) expect(isMetadataHost(new URL(u).hostname), u).toBe(true);
  });
});

describe('every address check refuses metadata, even when allow-listed', () => {
  it('MCP and connection hosts, service URLs, HTTP tools, cloud adapters, push providers, workflow steps', () => {
    for (const a of ADDRESSES) {
      expect(addressProblem(a, a, allow), `mcp ${a}`).not.toBeNull();
      expect(isNeverAddress(a), `never ${a}`).toBe(true);
      expect(serviceAddressProblem(a, a, policy), `service ${a}`).toMatch(/metadata/);
      expect(toolAddressProblem(a, a, policy, allow), `tool ${a}`).toMatch(/metadata/);
      expect(cloudAddressProblem(a, 'sts.amazonaws.com', policy, CLOUD_PROVIDER_HOSTS.aws), `cloud ${a}`).toMatch(/metadata/);
      expect(pushAddressProblem(a, a, 'http', policy, allow), `push ${a}`).toMatch(/metadata/);
      expect(isPublicAddress(a), `public ${a}`).toBe(false);
    }
    // A normal address under a metadata name, and a metadata address under a normal allow-listed name.
    for (const n of NAMES) {
      expect(serviceAddressProblem('10.0.0.5', n, policy), n).toMatch(/metadata/);
      expect(toolAddressProblem('203.0.113.5', n, policy, allow), n).toMatch(/metadata/);
      expect(addressProblem('10.0.0.5', n, allow), n).toMatch(/metadata/);
      expect(literalProblem(urlOf(n), policy), n).toMatch(/metadata/);
    }
    expect(toolAddressProblem('168.63.129.16', 'wire.example.com', policy, parseAllowList('wire.example.com'))).toMatch(/metadata/);
  });

  it('resolving checks refuse a metadata name before DNS and a normal name that resolves to metadata', async () => {
    for (const n of NAMES) {
      await expect(checkHost(n, allow), n).rejects.toThrow(/metadata/);
      await expect(checkUrl(urlOf(n), allow), n).rejects.toThrow(/metadata/);
      await expect(checkServiceHost(n, policy), n).rejects.toThrow(/metadata/);
      await expect(checkServiceUrl(urlOf(n), policy), n).rejects.toThrow(/metadata/);
    }
    for (const a of ADDRESSES) {
      rebindTo(a);
      await expect(checkHost(REBIND, allow), a).rejects.toThrow(/metadata|link-local/);
      await expect(checkServiceHost(REBIND, policy), a).rejects.toThrow(/metadata/);
      await expect(checkServiceUrl(`http://${REBIND}/`, policy, { requireResolve: true }), a).rejects.toThrow(/metadata/);
    }
  });
});

describe('every dialler refuses metadata at connect time', () => {
  it('guardedRequest (HTTP tools, REST connections, net built-ins, push, cloud transport) refuses whatever its check allows', async () => {
    const permissive = () => null;
    for (const h of [...ADDRESSES, ...NAMES]) await expect(guardedRequest({ method: 'GET', url: new URL(urlOf(h)), headers: {}, timeoutMs: 2000, maxBytes: 1024, check: permissive }), h).rejects.toThrow(/metadata/);
    for (const a of ADDRESSES) {
      rebindTo(a);
      await expect(guardedRequest({ method: 'GET', url: new URL(`http://${REBIND}/latest/`), headers: {}, timeoutMs: 2000, maxBytes: 1024, check: permissive }), a).rejects.toThrow(/metadata/);
    }
    // A legitimate call still goes through.
    const ok = await guardedRequest({ method: 'GET', url: new URL(`${siteUrl}/x`), headers: {}, timeoutMs: 5000, maxBytes: 1024, check: (addr, host) => toolAddressProblem(addr, host, servicePolicy({ SERVICE_ALLOWED_HOSTS: '127.0.0.1' }), null) });
    expect(ok.status).toBe(200);
  });

  it('guardedHttp2Connect (APNs, FCM) refuses metadata names and resolved addresses', async () => {
    for (const h of ['metadata.google.internal', '[fd00:ec2::254]', '169.254.169.254']) await expect(guardedHttp2Connect({ url: new URL(`https://${h}/`), check: () => null, connectTimeoutMs: 1000 }), h).rejects.toThrow(/metadata/);
    rebindTo('169.254.170.2');
    await expect(guardedHttp2Connect({ url: new URL(`https://${REBIND}/`), check: () => null, connectTimeoutMs: 1000 })).rejects.toThrow(/metadata/);
  });

  it('the undici dispatchers (MCP servers, webhooks, connections, service URLs, operator URLs) refuse a name that resolves to metadata', async () => {
    const agents = { guarded: guardedAgent(allow, 2000), service: serviceAgent(policy), safe: metadataSafeAgent() };
    try {
      for (const a of ['169.254.169.254', '168.63.129.16', '100.100.100.200', 'fd00:ec2::254', '::ffff:169.254.169.254']) {
        rebindTo(a);
        for (const [kind, dispatcher] of Object.entries(agents)) {
          const err = await fetch(`http://${REBIND}/latest/`, { dispatcher } as never).then(() => null, (e: Error & { cause?: Error }) => e);
          expect(err, `${kind} ${a}`).not.toBeNull();
          expect(String(err?.cause?.message ?? err?.message), `${kind} ${a}`).toMatch(/metadata|link-local/);
        }
        for (const n of ['metadata.google.internal', 'instance-data']) {
          const err = await fetch(`http://${n}/`, { dispatcher: agents.safe } as never).then(() => null, (e: Error & { cause?: Error }) => e);
          expect(String(err?.cause?.message ?? err?.message), n).toMatch(/metadata/);
        }
      }
      // A local service still answers through the metadata-only dispatcher.
      expect((await fetch(`${siteUrl}/`, { dispatcher: agents.safe } as never)).status).toBe(200);
    } finally {
      await Promise.all(Object.values(agents).map((x) => x.close()));
    }
  });
});

describe('a workflow HTTP step pointed at metadata is refused (B-10705 done-when)', () => {
  const base = { method: 'GET' as const, timeoutMs: 2000, allowLoopback: true };
  it('by address, by name, and by a name that resolves to metadata, whatever WORKFLOW_HTTP_HOSTS and the tenant list say', async () => {
    const listed = [...ADDRESSES, ...NAMES, REBIND];
    for (const h of [...ADDRESSES, ...NAMES]) await expect(internalRequest({ ...base, url: urlOf(h), allowHosts: listed, tenantAllow: allow }), h).rejects.toThrow(/metadata/);
    for (const a of ADDRESSES) {
      const net: HttpStepNet = { resolve: async (host) => (host === REBIND ? [{ address: a, family: a.includes(':') ? 6 : 4 }] : []) };
      await expect(internalRequest({ ...base, url: `http://${REBIND}/latest/`, allowHosts: listed, tenantAllow: allow, net }), a).rejects.toThrow(/metadata/);
    }
    // A local step still runs.
    const ok = await internalRequest({ ...base, url: `${siteUrl}/ok`, allowHosts: [] });
    expect(ok.status).toBe(200);
  });
});

describe('services and routes refuse metadata, even allow-listed by the operator and the tenant', () => {
  let h: Harness;
  let ollama: FakeOllama;
  const admin = (): Principal => ({ kind: 'user', userId: 'u-meta', tenantId: h.tenantId, tenantSlug: h.s.cfg.DEFAULT_TENANT, username: 'meta-admin', displayName: 'Meta admin', roles: ['system-admin'], clearance: 'restricted', scopes: null, sessionId: null, apiKeyId: null, mfa: true });

  beforeAll(async () => {
    h = await harness({ OLLAMA_POLL_MS: '600000', SERVICE_ALLOWED_HOSTS: ALLOW, MCP_ALLOWED_HOSTS: ALLOW, WEBHOOK_ALLOWED_HOSTS: ALLOW, WORKFLOW_HTTP_HOSTS: ALLOW, KNOWLEDGE_ALLOWED_HOSTS: ALLOW });
    await h.s.integrations.set(h.tenantId, { allowedHosts: ALLOW.split(',') }, 'test');
    ollama = await new FakeOllama().start();
    await seedRetrieval(h, ollama);
  });
  afterAll(async () => {
    await h?.close();
    await ollama?.stop();
  });

  it('an MCP server pointed at a metadata address or name is refused (done-when)', async () => {
    for (const host of [...ADDRESSES, ...NAMES.slice(0, 4)]) await expect(h.s.mcp.register(admin(), { name: 'imds', description: null, url: urlOf(host, '/mcp'), zone: 'tools', auth: 'none' }), host).rejects.toMatchObject({ status: 422 });
    rebindTo('169.254.169.254');
    await expect(h.s.mcp.register(admin(), { name: 'imds', description: null, url: `http://${REBIND}/mcp`, zone: 'tools', auth: 'none' })).rejects.toMatchObject({ status: 422 });
  });

  it('a webhook pointed at a metadata address or name is refused (done-when)', async () => {
    for (const host of [...ADDRESSES, ...NAMES.slice(0, 4)]) await expect(h.s.webhooks.create(h.tenantId, 'test', { name: 'imds', url: urlOf(host, '/hook'), events: ['*'], maxLabel: 'internal' }), host).rejects.toThrow(/metadata|link-local/);
    rebindTo('fd00:ec2::254');
    await expect(h.s.webhooks.create(h.tenantId, 'test', { name: 'imds', url: `http://${REBIND}/hook`, events: ['*'], maxLabel: 'internal' })).rejects.toThrow(/metadata|link-local/);
  });

  it('the net built-ins http_fetch and http_download refuse metadata', async () => {
    const member = await client(h, 'meta-mia', ['member'], 'internal');
    const p = (await loadPrincipal(h.s, h.tenantId, member.user.id, {}))!;
    const call = async (name: string, args: Record<string, unknown>) => {
      const { tools } = await h.s.tools.resolve(p, [name], 'internal');
      expect(tools[0], name).toBeTruthy();
      return h.s.tools.call({ principal: p, label: 'internal', approved: true, source: { kind: 'agent-run', id: 'R1' } }, tools[0]!, args);
    };
    for (const host of ['169.254.169.254', 'fd00:ec2::254', '168.63.129.16', '100.100.100.200', 'metadata.google.internal']) {
      expect((await call('http_fetch', { url: urlOf(host) })).error, host).toMatch(/metadata/);
      expect((await call('http_download', { url: urlOf(host) })).error ?? '', host).toMatch(/metadata/);
    }
    rebindTo('169.254.170.2');
    expect((await call('http_fetch', { url: `http://${REBIND}/v2/credentials` })).error).toMatch(/metadata/);
  });

  it('a knowledge web crawl source pointed at metadata is refused', async () => {
    const curator = await client(h, 'meta-cura', ['member', 'knowledge-curator'], 'confidential');
    const kb = (await curator.post('/api/knowledge/bases', { name: 'Meta', label: 'internal', embedModel: 'nomic-embed-text', sharing: 'members' }).expect(201)).body as { id: string };
    for (const host of ['169.254.169.254', 'fd00:ec2::254', '168.63.129.16', 'metadata.google.internal']) {
      const r = await curator.post(`/api/knowledge/bases/${kb.id}/sources`, { kind: 'web', location: urlOf(host, '/') });
      expect(r.status, host).toBeGreaterThanOrEqual(400);
      expect(String(r.body.detail), host).toMatch(/metadata|link-local/);
    }
  });
});

describe('operator-set URLs that had no address check refuse metadata (B-10705)', () => {
  it('the safe fetch, the image safety classifier, OpenBao, ACME, the Kubernetes API and the S3 endpoint', async () => {
    for (const h of [...ADDRESSES, ...NAMES]) await expect(metadataSafeFetch(urlOf(h)), h).rejects.toThrow(/metadata/);
    rebindTo('169.254.169.254');
    const err = await metadataSafeFetch(`http://${REBIND}/`).then(() => null, (e: Error & { cause?: Error }) => e);
    expect(String(err?.cause?.message ?? err?.message)).toMatch(/metadata/);
    expect((await metadataSafeFetch(`${siteUrl}/`)).status).toBe(200);

    await expect(new HttpSafety('http://169.254.169.254/classify').classify(Buffer.from('x'), 'image/png')).rejects.toThrow(/metadata/);
    const bao = vi.fn();
    await expect(new OpenBaoKms('http://169.254.169.254:8200', () => 'token', 'transit', undefined, bao as never).wrap('k', Buffer.from('x'), 'aad')).rejects.toThrow(/metadata/);
    expect(bao).not.toHaveBeenCalled();
    const acme = vi.fn();
    await expect(new HttpAcmeClient('http://[fd00:ec2::254]/directory', { pollMs: 10, fetch: acme as never }).register((await import('node:crypto')).generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey)).rejects.toThrow(/metadata/);
    expect(acme).not.toHaveBeenCalled();
    await expect(new KubeClient({ apiUrl: 'http://metadata.google.internal', token: () => 't', fieldManager: 'exprsn-ai' }).get('NetworkPolicy', 'default', 'x')).rejects.toThrow(/metadata/);
    await expect(new S3BlobStore({ endpoint: 'http://168.63.129.16', region: 'us-east-1', bucket: 'b', accessKeyId: 'AKIDTEST', secretAccessKey: 'secret', pathStyle: true }).get('k')).rejects.toThrow(/metadata/);
  });
});
