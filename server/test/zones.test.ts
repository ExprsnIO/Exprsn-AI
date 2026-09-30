import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProfileRow } from '../src/gateway/repo.js';
import { diffLines } from '../src/zones/render.js';
import { isPrivateCidr, overlaps } from '../src/zones/spec.js';
import { FakeOllama } from './fake-ollama.js';
import { harness, localUser, loginAdmin, type Client, type Harness } from './helpers.js';
import { seedGateway } from './seed-gateway.js';

describe('zones', () => {
  let h: Harness;
  let a: Client;
  let b: Client;
  const post = (c: Client, url: string, body: object = {}) => c.agent.post(url).set('x-csrf-token', c.csrf).send(body);
  const patch = (c: Client, url: string, body: object) => c.agent.patch(url).set('x-csrf-token', c.csrf).send(body);
  const zonesOf = async (c: Client) => (await c.agent.get('/api/admin/zones').expect(200)).body;

  beforeEach(async () => {
    h = await harness({ OLLAMA_POLL_MS: '600000', ZONE_HEALTH_FAILURES: '3', ZONE_HEALTH_TIMEOUT_MS: '500' });
    await localUser(h, 'root1', ['system-admin'], 'restricted');
    await localUser(h, 'root2', ['system-admin'], 'restricted');
    a = await loginAdmin(h, 'root1');
    b = await loginAdmin(h, 'root2');
  });
  afterEach(async () => {
    await h.close();
  });

  it('is for system admins only', async () => {
    await localUser(h, 'poolie', ['model-admin'], 'confidential');
    const m = await loginAdmin(h, 'poolie');
    await m.agent.get('/api/admin/zones').expect(403);
    await post(m, '/api/admin/zones/seed').expect(403);
    await post(m, '/api/admin/zones/app/proposals', { patch: { contents: 'x' } }).expect(403);
    await m.agent.get('/api/admin/zones/rendered/compose').expect(403);
    await request(h.app).get('/api/admin/zones').expect(401);
  });

  it('seeds the default zone set once, and changes nothing about routing before it', async () => {
    expect((await zonesOf(a)).zones).toEqual([]);
    expect(await h.s.zones.ceilingOf('inference')).toBeNull();
    const seeded = await post(a, '/api/admin/zones/seed').expect(201);
    expect(seeded.body.created).toEqual(['edge', 'app', 'data', 'directory', 'inference', 'sandbox', 'training', 'external']);
    const again = await post(b, '/api/admin/zones/seed').expect(200);
    expect(again.body.created).toEqual([]);
    const o = await zonesOf(a);
    expect(o.zones.map((z: { id: string; version: number }) => `${z.id}@${z.version}`)).toContain('inference@1');
    expect(o.problems).toEqual([]);
    expect(o.airGapped).toBe(true);
    expect(o.zones.find((z: { id: string }) => z.id === 'external')).toMatchObject({ external: true, spec: { maxLabel: 'internal', trust: 'external' } });
    expect(await h.s.zones.ceilingOf('inference')).toBe('confidential');
    const ev = await h.s.db('audit_events').where({ action: 'zone.seeded' });
    expect(ev).toHaveLength(1);
  });

  it('raises a seeded ceiling to what the zone already holds', async () => {
    await h.s.gateway.repo.createPool({ name: 'vault', accelerator: 'cuda', zone: 'inference', labelCeiling: 'restricted' });
    const seeded = await post(a, '/api/admin/zones/seed').expect(201);
    expect(seeded.body.adjusted).toEqual([{ zone: 'inference', from: 'confidential', to: 'restricted' }]);
    expect(await h.s.zones.ceilingOf('inference')).toBe('restricted');
  });

  it('proposes a draft, renders the diff and applies it only when a second system admin approves', async () => {
    await post(a, '/api/admin/zones/seed').expect(201);
    // An egress rule the target does not accept is refused with the reason.
    const bad = await post(a, '/api/admin/zones/sandbox/proposals', { patch: { egress: { mode: 'allow-list', allow: [{ kind: 'zone', zone: 'app', ports: [8080] }] } } }).expect(422);
    expect(bad.body.detail).toContain('app does not accept traffic from sandbox');

    const prop = await post(a, '/api/admin/zones/sandbox/proposals', { patch: { cidrs: ['10.50.0.0/23'], accepts: [{ kind: 'zone', zone: 'app', ports: [8443] }] }, reason: 'CHG-1182' }).expect(201);
    expect(prop.body).toMatchObject({ zone: 'sandbox', version: 2, status: 'draft', notified: 1 });
    await post(b, '/api/admin/zones/sandbox/proposals', { patch: { contents: 'x' } }).expect(409);

    // Routing still uses v1 while the draft waits.
    let o = await zonesOf(b);
    const sb = o.zones.find((z: { id: string }) => z.id === 'sandbox');
    expect(sb).toMatchObject({ version: 1, spec: { cidrs: ['10.50.0.0/24'] }, draft: { version: 2, reason: 'CHG-1182', proposedByName: 'ROOT1', mine: false } });

    const diff = (await b.agent.get('/api/admin/zones/sandbox/diff').expect(200)).body;
    expect(diff.from).toEqual({ version: 1, status: 'current' });
    expect(diff.to).toMatchObject({ version: 2, status: 'draft' });
    expect(diff.renders.networkpolicy.text).toContain('+        - {port: 8443, protocol: TCP}');
    expect(diff.renders.compose.text).toContain('-        - subnet: 10.50.0.0/24');
    expect(diff.renders.compose.text).toContain('+        - subnet: 10.50.0.0/23');
    expect(diff.renders.nftables.text).toContain('+    ip saddr { 10.20.0.0/22 } tcp dport { 8443 } accept comment "from app"');
    expect(diff.renders.nftables.added).toBeGreaterThan(0);

    const own = await post(a, '/api/admin/zones/sandbox/draft/approve', {}).expect(403);
    expect(own.body.step).toBe('dual-control');
    const ok = await post(b, '/api/admin/zones/sandbox/draft/approve', { note: 'Looks right' }).expect(200);
    expect(ok.body).toMatchObject({ version: 2, status: 'current', previous: 1 });
    o = await zonesOf(a);
    expect(o.zones.find((z: { id: string }) => z.id === 'sandbox')).toMatchObject({ version: 2, draft: null, spec: { cidrs: ['10.50.0.0/23'] } });

    const history = (await a.agent.get('/api/admin/zones/sandbox/versions').expect(200)).body;
    expect(history.map((v: { version: number; status: string }) => `${v.version}:${v.status}`)).toEqual(['2:current', '1:superseded']);
    expect(history[0]).toMatchObject({ proposedByName: 'ROOT1', decidedByName: 'ROOT2', decisionNote: 'Looks right' });
    const actions = (await h.s.db('audit_events').where('action', 'like', 'zone.%').orderBy('seq')).map((e: { action: string }) => e.action);
    expect(actions).toEqual(['zone.seeded', 'zone.proposed', 'zone.approved']);
    const past = (await a.agent.get('/api/admin/zones/sandbox/diff?version=2').expect(200)).body;
    expect(past.from).toEqual({ version: 1, status: 'superseded' });
  });

  it('withdraws and rejects drafts with the right people', async () => {
    await post(a, '/api/admin/zones/seed').expect(201);
    await post(a, '/api/admin/zones/data/proposals', { patch: { contents: 'PostgreSQL, Redis' } }).expect(201);
    await post(b, '/api/admin/zones/data/draft/withdraw').expect(403);
    await post(a, '/api/admin/zones/data/draft/reject', {}).expect(409);
    const rej = await post(b, '/api/admin/zones/data/draft/reject', { note: 'No ticket' }).expect(200);
    expect(rej.body.status).toBe('rejected');
    await post(a, '/api/admin/zones/data/proposals', { patch: { contents: 'PostgreSQL, Redis' } }).expect(201);
    await post(a, '/api/admin/zones/data/draft/withdraw').expect(200);
    await post(b, '/api/admin/zones/data/draft/approve', {}).expect(404);
    await post(a, '/api/admin/zones/data/proposals', { patch: {} }).expect(409);
  });

  it('refuses to lower a ceiling while placements, profiles and pools above it are in the zone, listing them', async () => {
    await post(a, '/api/admin/zones/seed').expect(201);
    const repo = h.s.gateway.repo;
    const pool = (await post(a, '/api/admin/pools', { name: 'gpu-large', accelerator: 'cuda', zone: 'inference', labelCeiling: 'confidential' }).expect(201)).body;
    const m = await repo.createModel({ name: 'qwen2.5:32b', source: 'Ollama library', expectedDigest: null, license: { name: 'test' }, label: 'confidential', notes: null, requestedBy: 'x', requestedTenant: h.tenantId });
    await repo.updateModel(m.id, { state: 'approved' });
    await repo.place(m.id, pool.id, 'warm', 'x');
    const t = Date.now();
    await repo.createProfile({ id: 'ANALYST0000000000000000000', tenant_id: h.tenantId, name: 'analyst', display_name: 'Analyst', description: null, alias_of: null, model_id: m.id, pool_id: null, num_ctx: null, temperature: null, think_default: 'off', think_ceiling: 'off', system_prompt: null, fallback: null, canary: null, tools: [], label: 'confidential', status: 'published', version: 1, updated_by: null, created_at: t, updated_at: t } as ProfileRow);

    const preview = (await a.agent.get('/api/admin/zones/inference/blockers?ceiling=internal').expect(200)).body;
    expect(preview.blockers).toHaveLength(3);
    const r = await post(a, '/api/admin/zones/inference/proposals', { patch: { maxLabel: 'internal' } }).expect(422);
    expect(r.body.title).toBe('Ceiling too low');
    expect(r.body.detail).toContain('Lowering inference to internal is refused while 1 placed model, 1 profile, 1 pool above internal are there');
    expect(r.body.step).toBe('zone-ceiling');
    expect(r.body.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'pool', pool: 'gpu-large', label: 'confidential' }),
        expect.objectContaining({ kind: 'placement', model: 'qwen2.5:32b', pool: 'gpu-large', label: 'confidential' }),
        expect.objectContaining({ kind: 'profile', profile: 'analyst', tenant: 'default', model: 'qwen2.5:32b', pool: 'gpu-large' })
      ])
    );
    expect(await h.s.zones.draft('inference')).toBeUndefined();
    // Raising is fine; the ceiling still applies to pools.
    await post(a, '/api/admin/zones/inference/proposals', { patch: { maxLabel: 'restricted' } }).expect(201);
  });

  it('keeps pools out of zones whose ceiling is below theirs, out of undefined zones, and out of the external zone', async () => {
    await post(a, '/api/admin/zones/seed').expect(201);
    const high = await post(a, '/api/admin/pools', { name: 'vault', accelerator: 'cuda', zone: 'inference', labelCeiling: 'restricted' }).expect(403);
    expect(high.body).toMatchObject({ step: 'zone', zoneCeiling: 'confidential' });
    await post(a, '/api/admin/pools', { name: 'cloud', accelerator: 'cpu', zone: 'external', labelCeiling: 'internal' }).expect(403);
    const unknown = await post(a, '/api/admin/pools', { name: 'lost', accelerator: 'cpu', zone: 'nowhere', labelCeiling: 'internal' }).expect(422);
    expect(unknown.body.title).toBe('Unknown zone');
    const pool = (await post(a, '/api/admin/pools', { name: 'cpu', accelerator: 'cpu', zone: 'inference', labelCeiling: 'internal' }).expect(201)).body;
    await patch(a, `/api/admin/pools/${pool.id}`, { labelCeiling: 'restricted' }).expect(403);
    await patch(a, `/api/admin/pools/${pool.id}`, { zone: 'sandbox' }).expect(200);
  });

  it('keeps the external zone empty and every zone off the internet in an air-gapped posture', async () => {
    await post(a, '/api/admin/zones/seed').expect(201);
    await h.s.gateway.repo.createPool({ name: 'cpu', accelerator: 'cpu', zone: 'inference', labelCeiling: 'internal' });
    const moved = await post(a, '/api/admin/zones/external/proposals', { patch: {}, movePools: ['cpu'] }).expect(422);
    expect(moved.body.detail).toContain('The external zone stays empty');
    const egress = await post(a, '/api/admin/zones/external/proposals', { patch: { egress: { mode: 'allow-list', allow: [{ kind: 'cidr', cidr: '203.0.113.0/24' }] } } }).expect(422);
    expect(egress.body.detail).toContain('no zone has internet egress');
    expect(egress.body.detail).toContain('The external zone has no egress in an air-gapped deployment');
    const cap = await post(a, '/api/admin/zones/external/proposals', { patch: { maxLabel: 'confidential' } }).expect(422);
    expect(cap.body.detail).toContain('capped at internal');
    const inet = await post(a, '/api/admin/zones/training/proposals', { patch: { egress: { mode: 'allow-list', allow: [{ kind: 'zone', zone: 'data', ports: [5432] }, { kind: 'cidr', cidr: '8.8.8.0/24', ports: [443] }] } } }).expect(422);
    expect(inet.body.problems[0]).toMatchObject({ zone: 'training', field: 'egress' });
    await post(a, '/api/admin/zones/external/endpoints', { name: 'openai', address: 'https://api.example.com' }).expect(403);
    // A new zone must reference defined zones and peers.
    const orphan = await post(a, '/api/admin/zones', { id: 'lab', spec: { maxLabel: 'internal', cidrs: ['10.70.0.0/24'], peers: [{ zone: 'mars', transport: 'wireguard', mtls: 'required' }] } }).expect(422);
    expect(orphan.body.detail).toContain('Peer mars is not a defined zone');
    const overlap = await post(a, '/api/admin/zones', { id: 'lab', spec: { maxLabel: 'internal', cidrs: ['10.40.8.0/24'] } }).expect(422);
    expect(overlap.body.detail).toContain('overlaps 10.40.0.0/16 in inference');
    await post(a, '/api/admin/zones', { id: 'seed', spec: { maxLabel: 'internal' } }).expect(422);
  });

  it('renders NetworkPolicy, Compose and nftables configuration for download', async () => {
    await post(a, '/api/admin/zones/seed').expect(201);
    const compose = await a.agent.get('/api/admin/zones/rendered/compose').expect(200);
    expect(compose.headers['content-disposition']).toBe('attachment; filename="exprsn-zones.compose.yaml"');
    const c = compose.text;
    expect(c).toContain('networks:\n  edge:');
    expect(c).toMatch(/ {2}data:\n {4}# max label restricted; egress denied\n {4}internal: true\n {4}driver: bridge/);
    expect(c).toContain('        - subnet: 10.40.0.0/16');
    expect(c).toContain('  app:\n    networks: [app, data, directory, inference, sandbox]');
    expect(c).toContain('  postgres:\n    networks: [data]');
    expect(c).toContain('  ollama:\n    networks: [inference]');
    expect(c).not.toContain('  external:');

    const np = (await a.agent.get('/api/admin/zones/inference/rendered/networkpolicy').expect(200)).text;
    expect(np).toContain('kind: NetworkPolicy');
    expect(np).toContain('  name: inference-zone\n  namespace: inference');
    expect(np).toContain('    - from:\n        - namespaceSelector: {matchLabels: {exprsn.ai/zone: app}}\n      ports:\n        - {port: 11434, protocol: TCP}');
    expect(np).toContain('policyTypes: [Ingress, Egress]');
    expect(np).not.toContain('exprsn.ai/zone: data}}');
    const edge = (await a.agent.get('/api/admin/zones/edge/rendered/networkpolicy').expect(200)).text;
    expect(edge).toContain('ZONES_CORPORATE_CIDRS is not set');
    const ext = (await a.agent.get('/api/admin/zones/external/rendered/networkpolicy').expect(200)).text;
    expect(ext).toContain('exists in the schema only');

    const nft = await a.agent.get('/api/admin/zones/data/rendered/nftables').expect(200);
    expect(nft.headers['content-disposition']).toBe('attachment; filename="data-v1.nftables.nft"');
    expect(nft.text).toContain('table inet exprsn_zone_data {');
    expect(nft.text).toContain('ip saddr { 10.20.0.0/22 } tcp dport { 5432, 6379 } accept comment "from app"');
    expect(nft.text).toContain('# egress denied: nothing leaves the zone');
    const all = (await a.agent.get('/api/admin/zones/rendered/networkpolicy').expect(200)).text;
    expect(all.split('kind: NetworkPolicy').length - 1).toBe(7);
    await a.agent.get('/api/admin/zones/rendered/terraform').expect(400);
  });

  it('renders corporate CIDRs when configured', async () => {
    await h.close();
    h = await harness({ ZONES_CORPORATE_CIDRS: '10.0.0.0/8, 192.168.0.0/16' });
    await localUser(h, 'root1', ['system-admin'], 'restricted');
    a = await loginAdmin(h, 'root1');
    await post(a, '/api/admin/zones/seed').expect(201);
    const edge = (await a.agent.get('/api/admin/zones/edge/rendered/networkpolicy').expect(200)).text;
    expect(edge).toContain('        - ipBlock: {cidr: 10.0.0.0/8}\n        - ipBlock: {cidr: 192.168.0.0/16}\n      ports:\n        - {port: 443, protocol: TCP}');
  });

  it('denies data above a zone ceiling in the gateway routing path', async () => {
    const ollama = await new FakeOllama().start();
    try {
      const { pool, model } = await seedGateway(h, ollama);
      await post(a, '/api/admin/zones/seed').expect(201);
      await post(a, '/api/admin/zones', { id: 'lab', spec: { contents: 'evaluation rigs', maxLabel: 'internal', cidrs: ['10.70.0.0/24'] }, reason: 'Lab' }).expect(201);
      await post(b, '/api/admin/zones/lab/draft/approve', {}).expect(200);
      // The API refuses the move; a pool row moved outside it (as before zones existed) is still never routed above the ceiling.
      await patch(a, `/api/admin/pools/${pool.id}`, { zone: 'lab' }).expect(403);
      await h.s.gateway.repo.updatePool(pool.id, { zone: 'lab' });
      const resolved = await h.s.gateway.resolve(h.tenantId, 'general');
      await expect(h.s.gateway.acquire(resolved.profile, resolved.model, 'confidential', { signal: new AbortController().signal })).rejects.toMatchObject({ status: 403, extensions: { step: 'zone', zone: 'lab', zoneCeiling: 'internal' } });
      const lease = await h.s.gateway.acquire(resolved.profile, resolved.model, 'internal', { signal: new AbortController().signal });
      expect(lease.pool.id).toBe(pool.id);
      lease.release();
      // Placement and profile publication follow the effective (zone) ceiling too.
      const placed = await post(a, '/api/admin/placements', { modelId: model.id, poolId: pool.id, pull: false }).expect(403);
      expect(placed.body.step).toBe('zone');
      expect(await h.s.zones.poolCeiling((await h.s.gateway.repo.pool(pool.id))!)).toBe('internal');
      // Back in inference (confidential), confidential data routes again.
      await h.s.gateway.repo.updatePool(pool.id, { zone: 'inference' });
      const ok = await h.s.gateway.acquire(resolved.profile, resolved.model, 'confidential', { signal: new AbortController().signal });
      ok.release();
    } finally {
      await ollama.stop();
    }
  });

  it('moves pools into a zone on approval', async () => {
    await post(a, '/api/admin/zones/seed').expect(201);
    await h.s.gateway.repo.createPool({ name: 'cpu', accelerator: 'cpu', zone: 'inference', labelCeiling: 'internal' });
    await post(a, '/api/admin/zones/sandbox/proposals', { patch: {}, movePools: ['cpu'], reason: 'Media workers' }).expect(201);
    expect((await h.s.gateway.repo.pools())[0]!.zone).toBe('inference');
    const ok = await post(b, '/api/admin/zones/sandbox/draft/approve', {}).expect(200);
    expect(ok.body.movedPools).toEqual(['cpu']);
    expect((await h.s.gateway.repo.pools())[0]!.zone).toBe('sandbox');
    await post(a, '/api/admin/zones/sandbox/proposals', { patch: {}, movePools: ['nope'] }).expect(404);
  });

  it('reports endpoint health from the poller and from its own checks, and drains members', async () => {
    const ollama = await new FakeOllama().start();
    const web: Server = createServer((_req, res) => res.end('ok'));
    await new Promise<void>((r) => web.listen(0, '127.0.0.1', r));
    try {
      const { pool } = await seedGateway(h, ollama);
      await post(a, '/api/admin/zones/seed').expect(201);
      const port = (web.address() as AddressInfo).port;
      const up = await post(a, '/api/admin/zones/data/endpoints', { name: 'minio', address: `http://127.0.0.1:${port}/minio/health/live`, kind: 'object storage' }).expect(201);
      expect(up.body).toMatchObject({ health: 'healthy', failures: 0 });
      const down = await post(a, '/api/admin/zones/data/endpoints', { name: 'postgres-2', address: '127.0.0.1:1' }).expect(201);
      expect(down.body).toMatchObject({ health: 'degraded', failures: 1 });
      await post(a, '/api/admin/zones/data/endpoints', { name: 'minio', address: '127.0.0.1:2' }).expect(409);
      await post(a, '/api/admin/zones/data/endpoints/check').expect(200);
      const checked = (await post(a, '/api/admin/zones/data/endpoints/check').expect(200)).body;
      expect(checked.find((e: { name: string }) => e.name === 'postgres-2')).toMatchObject({ health: 'unhealthy', failures: 3, checks: 3 });

      let o = await zonesOf(a);
      const data = o.zones.find((z: { id: string }) => z.id === 'data');
      expect(data.members.map((m: { name: string; health: string }) => `${m.name}:${m.health}`).sort()).toEqual(['minio:healthy', 'postgres-2:unhealthy']);
      const inf = o.zones.find((z: { id: string }) => z.id === 'inference');
      expect(inf.pools).toEqual([expect.objectContaining({ name: 'gpu', labelCeiling: 'confidential', effectiveCeiling: 'confidential', instances: 1 })]);
      expect(inf.members[0]).toMatchObject({ name: 'gpu-1', kind: 'instance', health: 'healthy', pool: 'gpu', drainable: true });

      ollama.down = true;
      await h.s.gateway.pollAll();
      o = await zonesOf(a);
      expect(o.zones.find((z: { id: string }) => z.id === 'inference').members[0].health).toBe('unhealthy');
      ollama.down = false;
      await h.s.gateway.pollAll();

      const instRef = `instance:${(await h.s.gateway.repo.instances(pool.id))[0]!.id}`;
      await post(a, '/api/admin/zones/data/members/drain', { ref: instRef }).expect(404);
      const drained = await post(a, '/api/admin/zones/inference/members/drain', { ref: instRef }).expect(200);
      expect(drained.body.state).toBe('draining');
      await post(a, '/api/admin/zones/inference/members/undrain', { ref: instRef }).expect(200);

      await post(a, '/api/admin/zones/data/members/drain', { ref: `endpoint:${down.body.id}` }).expect(200);
      const after = (await post(a, '/api/admin/zones/data/endpoints/check').expect(200)).body;
      expect(after.map((e: { name: string }) => e.name)).toEqual(['minio']);
      await a.agent.delete(`/api/admin/zones/data/endpoints/${down.body.id}`).set('x-csrf-token', a.csrf).expect(204);
      const actions = (await h.s.db('audit_events').where('action', 'like', 'zone.endpoint.%').orderBy('seq')).map((e: { action: string }) => e.action);
      expect(actions).toEqual(['zone.endpoint.added', 'zone.endpoint.added', 'zone.endpoint.drained', 'zone.endpoint.removed']);
    } finally {
      await new Promise((r) => web.close(r));
      await ollama.stop();
    }
  });

  it('diffs lines and classifies addresses', () => {
    expect(diffLines('a\nb\nc\n', 'a\nc\nd\n')).toEqual({ text: ' a\n-b\n c\n+d\n', added: 1, removed: 1 });
    expect(diffLines('', 'x\n')).toEqual({ text: '+x\n', added: 1, removed: 0 });
    expect(isPrivateCidr('10.40.0.0/16')).toBe(true);
    expect(isPrivateCidr('10.0.0.0/7')).toBe(false);
    expect(isPrivateCidr('fd00:1::/64')).toBe(true);
    expect(isPrivateCidr('8.8.8.0/24')).toBe(false);
    expect(overlaps('10.40.0.0/16', '10.40.8.0/24')).toBe(true);
    expect(overlaps('10.30.0.0/24', '10.31.0.0/24')).toBe(false);
  });
});
