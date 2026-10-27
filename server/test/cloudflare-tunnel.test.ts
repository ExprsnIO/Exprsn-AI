/*
 * 1.9.99-final, Sprint 61 (B-10902): a named Cloudflare Tunnel against `fake-cloudflare.ts` only. The tunnel is
 * created through the API (found again by name), its token read once into the vault and never answered by a route,
 * its ingress set remotely (the name to the app, a 404 catch-all); the chart, the systemd unit and the Compose file
 * run cloudflared beside the app with the token as a file and no inbound port; and Socket.io connects through a
 * stand-in for the connector that follows the tunnel's ingress as cloudflared does. Migration 161 is applied here
 * when missing.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { connect, type AddressInfo, type Socket as NetSocket } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { io as ioClient, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cloudTunnelTokenCommand } from '../src/cli/cloud-edge.js';
import { CloudVault } from '../src/cloud/cloud-vault.js';
import { CLOUDFLARED_IMAGE, edgeCreateSchema, type EdgeRow } from '../src/cloud/edge.js';
import { attachRealtime } from '../src/realtime/socket.js';
import { edgeWorld, type EdgeWorld } from './cloudflare-edge-helpers.js';

const repo = path.resolve(__dirname, '../..');

/** A stand-in for cloudflared: every request and upgrade goes to the tunnel's ingress rule for its name, with the client's address in CF-Connecting-IP. */
function connector(ingress: () => { hostname?: string; service: string }[], client = '198.51.100.23'): Promise<{ url: string; server: Server; seen: string[]; close: () => Promise<void> }> {
  const seen: string[] = [];
  const open = new Set<NetSocket>();
  const rule = () => ingress().find((r) => r.hostname) ?? null;
  const headersFor = (req: IncomingMessage, host: string) => ({ ...req.headers, host, 'cf-connecting-ip': client, 'x-forwarded-for': client, 'x-forwarded-proto': 'https' });
  const server = createServer((req, res) => {
    const r = rule();
    if (!r) return void res.writeHead(404).end();
    const u = new URL(r.service);
    seen.push(`http ${req.url}`);
    const up = httpRequest({ host: u.hostname, port: u.port, method: req.method, path: req.url, headers: headersFor(req, r.hostname!) }, (ur) => {
      res.writeHead(ur.statusCode ?? 502, ur.headers);
      ur.pipe(res);
    });
    req.pipe(up);
  });
  server.on('upgrade', (req: IncomingMessage, sock: NetSocket, head: Buffer) => {
    const r = rule();
    if (!r) return void sock.destroy();
    const u = new URL(r.service);
    seen.push(`upgrade ${req.url}`);
    open.add(sock);
    const up = connect(Number(u.port), u.hostname, () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`, ...Object.entries(headersFor(req, r.hostname!)).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`), '', ''];
      up.write(lines.join('\r\n'));
      if (head.length) up.write(head);
      up.pipe(sock);
      sock.pipe(up);
    });
    open.add(up);
    up.on('error', () => sock.destroy());
    sock.on('error', () => up.destroy());
  });
  // An upgraded socket is not one of the server's connections any more: close ends them too.
  const close = async () => {
    for (const x of open) x.destroy();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  };
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, seen, close })));
}

describe('B-10902: a Cloudflare Tunnel', () => {
  let w: EdgeWorld;
  let app: Server;
  let appPort = 0;
  let edge: EdgeRow;
  const host = 'ai.example.test';
  const sockets: Socket[] = [];

  beforeAll(async () => {
    w = await edgeWorld({ TRUST_PROXY: 'loopback,cloudflare', CLOUDFLARE_TUNNEL_PEERS: 'loopback' });
    app = createServer(w.h.app);
    attachRealtime(app, w.h.s);
    await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
    appPort = (app.address() as AddressInfo).port;
    edge = await w.h.s.cloud.edge.create(w.admin, edgeCreateSchema.parse({ name: 'tun', accountId: w.account.id, hostname: host, zone: 'example.test', origin: { kind: 'tunnel', service: `http://127.0.0.1:${appPort}` }, waf: { enabled: false } }));
    edge = await w.h.s.cloud.edge.apply(w.admin, edge.id);
  }, 180_000);
  afterAll(async () => {
    for (const s of sockets) s.close();
    app.closeAllConnections();
    await new Promise((r) => app.close(r));
    await w.stop();
  });

  it('creates the named tunnel through the API, and finds it again by name', async () => {
    expect(edge.state).toBe('applied');
    const tunnels = [...w.cf.tunnels.values()].filter((t) => !t.deleted_at);
    expect(tunnels).toHaveLength(1);
    expect(tunnels[0]).toMatchObject({ id: edge.tunnelId, name: 'exprsn-edge-edge-tun', config_src: 'cloudflare' });
    const again = await w.h.s.cloud.edge.apply(w.admin, edge.id);
    expect(again.tunnelId).toBe(edge.tunnelId);
    expect([...w.cf.tunnels.values()].filter((t) => !t.deleted_at)).toHaveLength(1);
    expect(again.steps.find((s) => s.step === 'tunnel')!.detail).toMatch(/^Found/);
  });

  it('keeps the token in the vault only', async () => {
    const token = w.cf.edge.tunnelTokens.get(edge.tunnelId!)!;
    expect(token.length).toBeGreaterThan(40);
    expect(edge.tokenRef).toBe(`vault:cloud/edge/${edge.id.toLowerCase()}#tunnel_token`);
    expect(await new CloudVault(() => w.h.s).read(edge.tokenRef!)).toBe(token);
    // Read once: applying again does not fetch it again.
    expect(w.cf.requests.filter((r) => r.path.endsWith('/token')).length).toBe(1);
    const c = w.admin.client;
    for (const p of ['/api/admin/cloud/edge', `/api/admin/cloud/edge/${edge.id}`, `/api/admin/cloud/edge/${edge.id}/install/helm`, `/api/admin/cloud/edge/${edge.id}/install/systemd`, `/api/admin/cloud/edge/${edge.id}/install/compose`]) {
      const r = await c.agent.get(p);
      expect(r.status, p).toBe(200);
      expect(JSON.stringify(r.body), p).not.toContain(token);
    }
    const audit = (await w.h.s.db('audit_events').where('action', 'like', 'cloud.edge.%').select('detail', 'target')) as { detail: string; target: string }[];
    expect(JSON.stringify(audit)).not.toContain(token);
  });

  it('writes the token to a new 0600 file for the connector, never over an existing one', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'exs-tun-'));
    try {
      const out = path.join(dir, 'token');
      const said: string[] = [];
      expect(await cloudTunnelTokenCommand(w.h.s, ['--edge', 'tun', '--out', out], (t) => void said.push(t))).toBe(0);
      expect(readFileSync(out, 'utf8')).toBe(w.cf.edge.tunnelTokens.get(edge.tunnelId!));
      expect(statSync(out).mode & 0o777).toBe(0o600);
      expect(said.join('')).not.toContain(w.cf.edge.tunnelTokens.get(edge.tunnelId!));
      await expect(cloudTunnelTokenCommand(w.h.s, ['--edge', 'tun', '--out', out], () => undefined)).rejects.toThrow(/EEXIST/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sets the ingress remotely: the name to the app, anything else 404', () => {
    const cfg = w.cf.edge.tunnelConfigs.get(edge.tunnelId!)!.config.ingress;
    expect(cfg).toEqual([{ hostname: host, service: `http://127.0.0.1:${appPort}`, originRequest: expect.objectContaining({ httpHostHeader: host }) }, { service: 'http_status:404' }]);
    const rec = [...w.cf.records.values()].find((r) => r.name === host)!;
    expect(rec).toMatchObject({ type: 'CNAME', content: `${edge.tunnelId}.cfargotunnel.com`, proxied: true });
  });

  it('connects Socket.io over WebSocket through the tunnel, with the client address from the connector', async () => {
    const conn = await connector(() => w.cf.edge.tunnelConfigs.get(edge.tunnelId!)!.config.ingress as { hostname?: string; service: string }[]);
    try {
      expect((await fetch(`${conn.url}/healthz`)).status).toBe(200);
      const sock = ioClient(conn.url, { path: '/socket.io', transports: ['websocket'], reconnection: false, extraHeaders: { cookie: w.admin.client.cookie } });
      sockets.push(sock);
      await new Promise<void>((resolve, reject) => {
        sock.on('ready', () => resolve());
        sock.on('connect_error', reject);
        setTimeout(() => reject(new Error('no ready event through the tunnel')), 20_000);
      });
      expect(conn.seen.some((x) => x.startsWith('upgrade /socket.io/'))).toBe(true);
      // The server took the connector's CF-Connecting-IP as the client (its peer is the loopback connector).
      const r = await fetch(`${conn.url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'nobody', password: 'wrong password' }) });
      expect(r.status).toBe(401);
      const keys = ((await w.h.s.db('login_throttle').where('key', 'like', 'ip:%')) as { key: string }[]).map((x) => x.key);
      expect(keys).toContain('ip:198.51.100.23');
    } finally {
      for (const x of sockets.splice(0)) x.close();
      await conn.close();
    }
  });

  it('runs cloudflared beside the app with no inbound port: the install settings', async () => {
    const c = w.admin.client;
    const helm = (await c.agent.get(`/api/admin/cloud/edge/${edge.id}/install/helm`)).body;
    expect(helm).toMatchObject({ image: CLOUDFLARED_IMAGE, inboundPorts: [], values: { ingress: { enabled: false }, service: { type: 'ClusterIP' }, cloudflared: { enabled: true, tokenSecret: { name: 'exprsn-ai-cloudflared', key: 'token' } }, config: { trustProxy: 'uniquelocal,cloudflare' } }, ingress: { websocket: '/socket.io/' } });
    const sd = (await c.agent.get(`/api/admin/cloud/edge/${edge.id}/install/systemd`)).body;
    expect(sd).toMatchObject({ env: { HOST: '127.0.0.1', TRUST_PROXY: 'loopback,cloudflare', CLOUDFLARE_TUNNEL_PEERS: 'loopback' }, inboundPorts: [] });
    const compose = (await c.agent.get(`/api/admin/cloud/edge/${edge.id}/install/compose`)).body;
    expect(compose).toMatchObject({ file: 'deploy/docker/compose.tunnel.yml', inboundPorts: [] });
    expect((await c.agent.get(`/api/admin/cloud/edge/${edge.id}/install/nomad`)).status).toBe(400);
    // The pinned image is a dated release, not a moving tag.
    expect(CLOUDFLARED_IMAGE).toMatch(/^cloudflare\/cloudflared:20\d\d\.\d+\.\d+$/);
  });

  it('the systemd unit and the Compose file take the token as a file and publish nothing', () => {
    const unit = readFileSync(path.join(repo, 'deploy/baremetal/exprsn-cloudflared.service'), 'utf8');
    expect(unit).toMatch(/^LoadCredential=cloudflared_token:\/etc\/exprsn-ai\/credentials\/cloudflared_token$/m);
    expect(unit).toMatch(/^ExecStart=.*cloudflared tunnel --no-autoupdate .*run --token-file \$\{CREDENTIALS_DIRECTORY\}\/cloudflared_token$/m);
    expect(unit).not.toMatch(/^Environment=.*TUNNEL_TOKEN/m);
    expect(unit).not.toMatch(/ListenStream|--url/);
    const compose = readFileSync(path.join(repo, 'deploy/docker/compose.tunnel.yml'), 'utf8');
    expect(compose).toMatch(/^ {4}ports: !reset \[\]$/m);
    const cfBlock = compose.slice(compose.indexOf('  cloudflared:'), compose.indexOf('\nnetworks:'));
    expect(cfBlock).not.toMatch(/ports:/);
    expect(cfBlock).toMatch(/--token-file", "\/run\/secrets\/cloudflared_token/);
    expect(cfBlock).not.toMatch(/TUNNEL_TOKEN/);
    expect(cfBlock).toContain(CLOUDFLARED_IMAGE);
  });

  it('the chart renders the connector with no ingress, no public Service and the token mounted from a Secret', async () => {
    const chart = path.join(repo, 'deploy/helm/exprsn-ai');
    const bin = process.env.HELM_BIN;
    let docs: string;
    if (bin) {
      const { stdout } = await promisify(execFile)(bin, ['template', 'ci', chart, '-f', path.join(chart, 'ci/tunnel-values.yaml')], { maxBuffer: 16 * 1024 * 1024 });
      docs = stdout;
      await expect(promisify(execFile)(bin, ['template', 'ci', chart, '-f', path.join(chart, 'ci/tunnel-values.yaml'), '--set', 'ingress.enabled=true'])).rejects.toThrow(/ingress.enabled=false/);
    } else docs = readFileSync(path.join(chart, 'templates/cloudflared.yaml'), 'utf8');
    if (bin) {
      expect(docs).not.toMatch(/^kind: Ingress$/m);
      expect(docs).not.toMatch(/type: (LoadBalancer|NodePort)/);
      expect(docs).toMatch(/type: ClusterIP/);
      expect(docs).toMatch(/name: ci-exprsn-ai-cloudflared/);
    }
    expect(docs).not.toMatch(/hostPort|hostNetwork: true/);
    expect(docs).toMatch(/--token-file", "\/run\/secrets\/cloudflared\/token"/);
    expect(docs).not.toMatch(/TUNNEL_TOKEN/);
    const values = readFileSync(path.join(chart, 'values.yaml'), 'utf8');
    expect(values).toContain(`tag: "${CLOUDFLARED_IMAGE.split(':')[1]}"`);
  });
});
