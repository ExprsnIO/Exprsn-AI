import { migrationSource } from '../src/db/migrations/index.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { io as ioClient, type Socket } from 'socket.io-client';
import { Registry } from 'prom-client';
import { eventsCommand, parseTime, pluginsCommand } from '../src/cli/core.js';
import { migrateCheck } from '../src/db/schema.js';
import { catalogue, EVENT_TYPES, knownPattern, validateEvent, type EventEnvelope } from '../src/events/catalogue.js';
import { loadPrincipal } from '../src/http/middleware.js';
import { createLogger } from '../src/observability/index.js';
import { Bus, TOPICS } from '../src/platform/bus.js';
import { MemoryCacheStore, RedisCacheStore, TenantCache } from '../src/platform/cache.js';
import { validateManifest, ManifestError } from '../src/plugins/manifest.js';
import { attachRealtime } from '../src/realtime/socket.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';
import { MiniRedis } from './sprint24c-fakes.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error('timed out');
    await sleep(10);
  }
}
const send = (c: Client, method: 'post' | 'put' | 'patch' | 'delete', url: string, body: object = {}) => c.agent[method](url).set('x-csrf-token', c.csrf).send(body);

const manifest = (over: Record<string, unknown> = {}) => ({
  key: 'flag-notifier',
  name: 'Flag notifier',
  version: '1.0.0',
  kind: 'declarative',
  events: ['flag.*'],
  capabilities: ['read:events', 'emit:notification', 'call:webhook'],
  optionalCapabilities: [],
  actions: [
    { type: 'notify', on: 'flag.created' },
    { type: 'webhook', on: 'flag.escalated' }
  ],
  ...over
});

// ---------- B-2001 ----------

describe('event catalogue (B-2001)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('serves the versioned catalogue to webhook and plugin managers only', async () => {
    await localUser(h, 'ta', ['tenant-admin'], 'confidential');
    const admin = await loginAdmin(h, 'ta');
    const res = await admin.agent.get('/api/events/catalogue').expect(200);
    expect(res.body.version).toBeGreaterThanOrEqual(2);
    expect(res.body.groups.map((g: { pattern: string }) => g.pattern)).toEqual(expect.arrayContaining(['record.*', 'file.*', 'group.*', 'message.*', 'post.*', 'plugin.*', 'flag.*', 'job.*']));
    const rec = res.body.types.find((t: { type: string }) => t.type === 'record.created');
    expect(rec).toMatchObject({ group: 'record.*', version: 1, status: 'emitted', since: '1.4.0' }); // emitted since Sprint 27 (B-22)
    expect(rec.schema.required).toContain('record');
    expect(res.body.types.find((t: { type: string }) => t.type === 'job.failed')).toMatchObject({ status: 'emitted' });
    expect(res.body.auditActions.schema.required).toEqual(expect.arrayContaining(['action', 'seq', 'hash']));
    await admin.agent.get('/api/events/catalogue').set('if-none-match', res.headers.etag!).expect(304);
    // webhook groups are the catalogue's
    expect((await admin.agent.get('/api/admin/webhooks').expect(200)).body.events).toEqual(catalogue().groups);
    await localUser(h, 'm', ['member']);
    const m = await login(h, 'm');
    await m.agent.get('/api/events/catalogue').expect(403);
  });

  it('validates envelopes and data, and knows which patterns it covers', () => {
    const base = { id: 'job:1:failed', tenant: 'T', label: 'internal', createdAt: new Date().toISOString() };
    expect(validateEvent({ ...base, type: 'job.failed', data: { id: '01J', type: 'x.y', state: 'failed', error: 'boom' } })).toEqual([]);
    expect(validateEvent({ ...base, type: 'job.failed', data: { id: '01J', type: 'x.y', state: 'exploded', error: null } })[0]).toMatch(/job.failed data\/state/);
    expect(validateEvent({ ...base, type: 'flag.created', data: { flag: 'F-1' } }).length).toBeGreaterThan(0);
    expect(validateEvent({ ...base, label: 'secret', type: 'job.failed', data: {} })[0]).toMatch(/^envelope\/label/);
    // anything else is an audit action and must look like an audit entry
    expect(validateEvent({ ...base, type: 'user.created', data: { seq: 3, action: 'user.created', kind: 'admin', actor: { user: null, username: null, service: 'cli' }, target: {}, detail: null, decision: null, traceId: null, hash: 'a'.repeat(64) } })).toEqual([]);
    expect(validateEvent({ ...base, type: 'user.created', data: { action: 'user.created' } }).length).toBeGreaterThan(0);
    expect(knownPattern('record.*')).toBe(true);
    expect(knownPattern('record.updated')).toBe(true);
    expect(knownPattern('webhook.created')).toBe(true);
    expect(knownPattern('spaceship.*')).toBe(false);
    for (const t of EVENT_TYPES) expect(knownPattern(t.type)).toBe(true);
  });

  it('every event the code emits matches its schema, and so does every delivery body', async () => {
    const seen: { e: EventEnvelope; problems: string[] }[] = [];
    const check = h.s.events.check.bind(h.s.events);
    h.s.events.check = (e) => {
      const problems = check(e);
      seen.push({ e, problems });
      return problems;
    };
    await localUser(h, 'ta', ['tenant-admin', 'flag-reviewer'], 'restricted');
    const reviewer = await localUser(h, 'rev', ['flag-reviewer'], 'restricted');
    const admin = await loginAdmin(h, 'ta');
    const hook = (await send(admin, 'post', '/api/admin/webhooks', { name: 'all', url: 'http://127.0.0.1:9/hook', events: ['*'], maxLabel: 'restricted' }).expect(201)).body;

    // jobs: succeeded, failed, cancelled
    h.s.jobs.register('test.ok', async () => ({ ok: true }));
    h.s.jobs.register('test.fail', async () => {
      throw new Error('it broke');
    });
    await h.s.jobs.enqueue({ tenantId: h.tenantId, type: 'test.ok', payload: {} });
    await h.s.jobs.enqueue({ tenantId: h.tenantId, type: 'test.fail', payload: {}, maxAttempts: 1 });
    const later = await h.s.jobs.enqueue({ tenantId: h.tenantId, type: 'test.ok', payload: {}, runAt: Date.now() + 3_600_000 });
    await h.s.jobs.cancel(h.tenantId, later.id);
    await h.s.jobs.runDue();

    // flags: created, confirmed, dismissed, escalated, reassigned
    const ta = await h.s.users.byUsername(h.tenantId, 'ta');
    const p = (await loadPrincipal(h.s, h.tenantId, ta!.id, {}))!;
    const flags = h.s.guard.flags;
    const mk = () => flags.create({ tenantId: h.tenantId, workspaceId: null, kind: 'rule', checkpoint: 'user-input', ruleName: 'Card numbers', severity: 'high', label: 'internal', text: 'card 4111', span: [5, 9] });
    const f1 = await mk();
    const f2 = await mk();
    const f3 = await mk();
    await flags.decide(p, `F-${f1.number}`, [], 'confirmed', 'real');
    await flags.decide(p, `F-${f2.number}`, [], 'dismissed', null);
    await flags.escalate(p, `F-${f3.number}`, [], 'tenant', 'look');
    await flags.reassign(p, `F-${f3.number}`, [], reviewer.id);
    await sleep(50);

    const types = new Set(seen.map((x) => x.e.type));
    for (const t of ['webhook.created', 'job.succeeded', 'job.failed', 'job.cancelled', 'flag.created', 'flag.confirmed', 'flag.dismissed', 'flag.escalated', 'flag.reassigned']) expect(types, t).toContain(t);
    expect(seen.filter((x) => x.problems.length)).toEqual([]);
    expect(await h.s.events.violations.get()).toMatchObject({ values: [] });

    // what is queued for the receiver is the same envelope
    const rows = (await h.s.db('webhook_deliveries').where({ webhook_id: hook.id })) as { id: string; payload: string }[];
    expect(rows.length).toBeGreaterThanOrEqual(9);
    for (const r of rows) expect(validateEvent(JSON.parse(await h.s.keys.open(h.tenantId, r.payload, `webhook-delivery:${r.id}`)))).toEqual([]);
  });
});

// ---------- B-2002 ----------

describe('plugins (B-2002)', () => {
  let h: Harness;
  let admin: Client;
  beforeEach(async () => {
    h = await harness();
    await localUser(h, 'ta', ['tenant-admin'], 'confidential');
    admin = await loginAdmin(h, 'ta');
  });
  afterEach(async () => {
    await h.close();
  });

  it('refuses a manifest asking for a capability outside the vocabulary, and other untrusted shapes', async () => {
    const bad = await send(admin, 'post', '/api/admin/plugins', { manifest: manifest({ capabilities: ['read:events', 'emit:notification', 'call:webhook', 'exec:shell'] }) }).expect(422);
    expect(bad.body.detail).toMatch(/not in the capability vocabulary: exec:shell/);
    expect(bad.body.errors).toEqual(expect.arrayContaining([expect.stringMatching(/exec:shell/)]));
    expect(await h.s.db('plugins').count({ n: '*' }).first()).toMatchObject({ n: 0 });
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ events: ['spaceship.*'] }, /spaceship.\* is not in the event catalogue/],
      [{ events: ['record.*'] }, /record.\* needs read:records/],
      [{ capabilities: ['read:events', 'call:webhook'] }, /a notify action needs the emit:notification capability/],
      [{ optionalCapabilities: ['emit:flag'] }, /emit:flag is not among the capabilities/],
      [{ version: 'one' }, /version: a semantic version/],
      [{ entrypoint: 'index.js' }, /Unrecognized key/i],
      [{ kind: 'webhook' }, /a webhook plugin names its endpoint/],
      [{ config: { schema: { type: 'nonsense' } } }, /config.schema: not a JSON Schema/]
    ];
    for (const [over, re] of cases) {
      const r = await send(admin, 'post', '/api/admin/plugins/validate', { manifest: manifest(over) });
      expect(r.status, JSON.stringify(over)).toBe(422);
      expect((r.body.errors as string[]).join('\n')).toMatch(re);
    }
    expect(() => validateManifest(manifest({ capabilities: ['root'] }))).toThrow(ManifestError);
    expect((await send(admin, 'post', '/api/admin/plugins/validate', { manifest: manifest() }).expect(200)).body).toMatchObject({ valid: true, manifest: { key: 'flag-notifier' } });
    const caps = (await admin.agent.get('/api/admin/plugins/capabilities').expect(200)).body;
    expect(caps.capabilities.map((c: { name: string }) => c.name)).toContain('read:events');
  });

  it('installs, enables, disables and removes per tenant with every transition audited', async () => {
    const installed = (await send(admin, 'post', '/api/admin/plugins', { manifest: manifest(), config: {} }).expect(201)).body;
    // high-risk capabilities are not granted by default, and a required one blocks enabling
    expect(installed).toMatchObject({ key: 'flag-notifier', state: 'installed', granted: ['read:events', 'emit:notification'], missing: ['call:webhook'] });
    const refused = await send(admin, 'post', `/api/admin/plugins/${installed.id}/enable`).expect(409);
    expect(refused.body.missing).toEqual(['call:webhook']);
    await send(admin, 'put', `/api/admin/plugins/${installed.id}/grants`, { grants: ['read:events', 'emit:notification', 'call:webhook', 'emit:flag'] }).expect(400);
    await send(admin, 'put', `/api/admin/plugins/${installed.id}/grants`, { grants: ['read:events', 'emit:notification', 'call:webhook'], reason: 'reviewed the endpoint' }).expect(200);
    expect((await send(admin, 'post', `/api/admin/plugins/${installed.id}/enable`).expect(200)).body.state).toBe('enabled');
    await send(admin, 'post', `/api/admin/plugins/${installed.id}/enable`).expect(409); // already enabled
    expect(await h.s.plugins.enabled(h.tenantId)).toEqual([expect.objectContaining({ key: 'flag-notifier', granted: ['read:events', 'emit:notification', 'call:webhook'] })]);
    // withdrawing a required grant from an enabled plugin disables it
    const shrunk = (await send(admin, 'put', `/api/admin/plugins/flag-notifier/grants`, { grants: ['read:events', 'emit:notification'] }).expect(200)).body;
    expect(shrunk).toMatchObject({ state: 'disabled', missing: ['call:webhook'] });
    expect(await h.s.plugins.enabled(h.tenantId)).toEqual([]);
    await send(admin, 'post', '/api/admin/plugins', { manifest: manifest() }).expect(409); // already installed
    await send(admin, 'delete', `/api/admin/plugins/${installed.id}?reason=retired`).expect(204);
    expect((await admin.agent.get('/api/admin/plugins').expect(200)).body.plugins).toEqual([]);
    expect((await admin.agent.get('/api/admin/plugins?removed=true').expect(200)).body.plugins[0]).toMatchObject({ state: 'removed' });
    await send(admin, 'post', `/api/admin/plugins/${installed.id}/enable`).expect(409);
    // reinstalling a removed plugin, at a new version
    const again = (await send(admin, 'post', '/api/admin/plugins', { manifest: manifest({ version: '1.1.0' }), grants: ['read:events', 'emit:notification', 'call:webhook'] }).expect(201)).body;
    expect(again).toMatchObject({ id: installed.id, version: '1.1.0', state: 'installed', missing: [] });

    const detail = (await admin.agent.get(`/api/admin/plugins/${installed.id}`).expect(200)).body;
    expect(detail.transitions.map((t: { event: string; from: string | null; to: string }) => `${t.event}:${t.from}>${t.to}`)).toEqual(['install:null>installed', 'grants:installed>installed', 'enable:installed>enabled', 'grants:enabled>disabled', 'remove:disabled>removed', 'install:removed>installed']);
    const actions = ((await h.s.db('audit_events').where('action', 'like', 'plugin.%').orderBy('seq')) as { action: string }[]).map((r) => r.action);
    expect(actions).toEqual(['plugin.installed', 'plugin.grants.updated', 'plugin.enabled', 'plugin.grants.updated', 'plugin.removed', 'plugin.reinstalled']);

    // another tenant sees none of it
    const other = await h.s.tenants.create({ slug: 'other', name: 'Other' });
    expect(await h.s.plugins.list(other.id, 'restricted')).toEqual([]);
  });

  it('needs plugins:manage, keeps to the installer clearance, stores config sealed and takes scripts only from signed bundles', async () => {
    await localUser(h, 'm', ['member']);
    const m = await login(h, 'm');
    await m.agent.get('/api/admin/plugins').expect(403);
    await send({ agent: m.agent, csrf: m.csrf, cookie: m.cookie }, 'post', '/api/admin/plugins', { manifest: manifest() }).expect(403);
    await send(admin, 'post', '/api/admin/plugins', { manifest: manifest(), maxLabel: 'restricted' }).expect(403);

    const withConfig = manifest({ key: 'tagger', config: { schema: { type: 'object', properties: { channel: { type: 'string' } }, required: ['channel'], additionalProperties: false } } });
    await send(admin, 'post', '/api/admin/plugins', { manifest: withConfig, config: { other: 1 } }).expect(422);
    const p = (await send(admin, 'post', '/api/admin/plugins', { manifest: withConfig, config: { channel: '#ops' } }).expect(201)).body;
    expect(p.configured).toBe(true);
    const raw = await h.s.db('plugins').where({ id: p.id }).first();
    expect(raw.config_sealed).toMatch(/^v2\./);
    expect(raw.config_sealed).not.toContain('#ops');

    const script = manifest({ key: 'scripted', kind: 'script', actions: undefined, capabilities: ['read:events'], events: ['flag.*'], script: { entry: 'main', source: 'export default () => 1' } });
    // Sprint 25 (B-2005): a script plugin is installed only from a signed import bundle (PLUGINS_REQUIRE_SIGNED=scripts)
    expect((await send(admin, 'post', '/api/admin/plugins', { manifest: script }).expect(409)).body.detail).toMatch(/script plugin.*signed import bundle/);
    await h.s.db('plugins').insert({ id: '01JSCRIPTPLUGIN00000000000', tenant_id: h.tenantId, plugin_key: 'scripted', name: 'scripted', version: '1.0.0', kind: 'script', manifest: JSON.stringify(validateManifest(script)), manifest_hash: 'x'.repeat(64), granted: '["read:events"]', max_label: 'internal', state: 'installed', state_changed_at: 1, created_at: 1, updated_at: 1 });
    // one stored inline before Sprint 25 cannot be enabled either
    expect((await send(admin, 'post', '/api/admin/plugins/scripted/enable').expect(409)).body.detail).toMatch(/signed import bundle/);
    expect((await admin.agent.get('/api/admin/plugins/scripted').expect(200)).body.manifest.script).toEqual({ entry: 'main', bytes: 22 });
  });
});

// ---------- B-2101 ----------

describe('realtime rooms for the new domains (B-2101)', () => {
  let h: Harness;
  let server: Server;
  let url: string;
  let sockets: Socket[];
  const members = new Map<string, Set<string>>();

  beforeEach(async () => {
    h = await harness();
    server = createServer(h.app);
    attachRealtime(server, h.s);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    sockets = [];
    members.clear();
  });
  afterEach(async () => {
    for (const s of sockets) s.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await h.close();
  });

  async function person(name: string, clearance: 'internal' | 'confidential' = 'internal') {
    const user = await localUser(h, name, ['member'], clearance);
    const c = await login(h, name);
    const sock = ioClient(url, { path: '/socket.io', transports: ['websocket'], reconnection: false, extraHeaders: { cookie: c.cookie } });
    sockets.push(sock);
    await new Promise((r) => sock.on('ready', r));
    const got: { event: string; data: Record<string, unknown> }[] = [];
    sock.onAny((event: string, data: Record<string, unknown>) => void got.push({ event, data }));
    return { user, sock, got };
  }
  const join = (sock: Socket, kind: string, id: string) => new Promise<{ ok: boolean; label?: string; error?: string }>((r) => sock.emit('room.join', { kind, id }, r));
  const GROUP = '01J0GR0P000000000000000000';

  it('removing a group member closes their room at once; others keep receiving', async () => {
    const ws = await h.s.tenants.createWorkspace(h.tenantId, 'Ops', 'internal');
    h.s.rooms.register('group', async (p, id) => (members.get(id)?.has(p.userId) ? { label: 'internal', workspaceId: ws.id } : null));
    const ann = await person('ann');
    const bob = await person('bob');
    const eve = await person('eve');
    members.set(GROUP, new Set([ann.user.id, bob.user.id]));
    expect(await join(ann.sock, 'group', GROUP)).toEqual({ ok: true, label: 'internal' });
    expect(await join(bob.sock, 'group', GROUP)).toMatchObject({ ok: true });
    expect(await join(eve.sock, 'group', GROUP)).toMatchObject({ ok: false });
    expect(await join(eve.sock, 'feed', GROUP)).toMatchObject({ ok: false }); // no authoriser for feeds yet
    expect(await join(eve.sock, 'spaceship', GROUP)).toMatchObject({ ok: false });
    expect(() => h.s.rooms.emit({ tenantId: h.tenantId, kind: 'group', id: GROUP, event: 'session.revoked', data: {} })).toThrow(/group\.<name>/);

    h.s.rooms.emit({ tenantId: h.tenantId, kind: 'group', id: GROUP, event: 'group.post', data: { n: 1 } });
    await until(() => ann.got.some((g) => g.event === 'group.post') && bob.got.some((g) => g.event === 'group.post'));
    expect(ann.got.find((g) => g.event === 'group.post')!.data).toEqual({ kind: 'group', id: GROUP, n: 1 });

    // Bob is removed: the domain changes membership and says so; the very next event no longer reaches him.
    members.get(GROUP)!.delete(bob.user.id);
    h.s.rooms.accessChanged({ tenantId: h.tenantId, kind: 'group', id: GROUP, userIds: [bob.user.id] });
    h.s.rooms.emit({ tenantId: h.tenantId, kind: 'group', id: GROUP, event: 'group.post', data: { n: 2 } });
    await until(() => bob.got.some((g) => g.event === 'room.closed') && ann.got.filter((g) => g.event === 'group.post').length === 2);
    expect(bob.got.filter((g) => g.event === 'group.post').map((g) => g.data.n)).toEqual([1]);
    expect(bob.got.find((g) => g.event === 'room.closed')!.data).toEqual({ kind: 'group', id: GROUP });
    expect(eve.got.some((g) => g.event === 'group.post')).toBe(false);

    // Losing the workspace the grant came through closes the room too.
    await h.s.tenants.addMember(ws.id, ann.user.id);
    members.get(GROUP)!.delete(ann.user.id);
    h.s.bus.publish(TOPICS.workspaceMembership, { tenantId: h.tenantId, userId: ann.user.id, workspaceIds: [ws.id] });
    h.s.rooms.emit({ tenantId: h.tenantId, kind: 'group', id: GROUP, event: 'group.post', data: { n: 3 } });
    await until(() => ann.got.some((g) => g.event === 'room.closed'));
    await sleep(50);
    expect(ann.got.filter((g) => g.event === 'group.post').map((g) => g.data.n)).toEqual([1, 2]);
  });

  it('a raised label removes readers below it, and a member still entitled is let back in', async () => {
    let label: 'internal' | 'confidential' = 'internal';
    h.s.rooms.register('channel', async () => ({ label }));
    const low = await person('low', 'internal');
    const high = await person('high', 'confidential');
    const CH = '01J0CHANNE1000000000000000';
    expect(await join(low.sock, 'channel', CH)).toMatchObject({ ok: true });
    expect(await join(high.sock, 'channel', CH)).toMatchObject({ ok: true });
    label = 'confidential';
    h.s.rooms.accessChanged({ tenantId: h.tenantId, kind: 'channel', id: CH, label });
    h.s.rooms.emit({ tenantId: h.tenantId, kind: 'channel', id: CH, event: 'channel.reply', data: { n: 1 } });
    await until(() => low.got.some((g) => g.event === 'room.closed') && high.got.some((g) => g.event === 'channel.reply'));
    expect(low.got.some((g) => g.event === 'channel.reply')).toBe(false);
    // an access check with no names re-checks everyone where they are: the cleared reader never leaves
    h.s.rooms.accessChanged({ tenantId: h.tenantId, kind: 'channel', id: CH });
    h.s.rooms.emit({ tenantId: h.tenantId, kind: 'channel', id: CH, event: 'channel.reply', data: { n: 2 } });
    await until(() => high.got.filter((g) => g.event === 'channel.reply').length === 2);
  });
});

// ---------- B-2102 ----------

describe('tenant-scoped read-through cache (B-2102)', () => {
  const log = createLogger('silent', false);
  const ttl = { short: 1, medium: 60, long: 600 };

  it('reads through with hit and miss metrics, keeps tenants apart and expires by tier', async () => {
    const bus = new Bus(log);
    const reg = new Registry();
    const cache = new TenantCache(new MemoryCacheStore(), bus, reg, { ttlSeconds: ttl });
    let loads = 0;
    const load = (v: string) => async () => {
      loads++;
      return { v };
    };
    expect(await cache.get('T1', 'webhooks', 'active', 'short', load('a'))).toEqual({ v: 'a' });
    expect(await cache.get('T1', 'webhooks', 'active', 'short', load('b'))).toEqual({ v: 'a' });
    expect(await cache.get('T2', 'webhooks', 'active', 'short', load('c'))).toEqual({ v: 'c' });
    expect(loads).toBe(2);
    // concurrent misses share one load
    await Promise.all([1, 2, 3].map(() => cache.get('T1', 'plugins', 'enabled', 'medium', load('d'))));
    expect(loads).toBe(3);
    const metric = await reg.getSingleMetric('exprsn_cache_requests_total')!.get();
    const count = (ns: string, result: string) => metric.values.filter((x) => x.labels.ns === ns && x.labels.result === result).reduce((a, x) => a + x.value, 0);
    expect(count('webhooks', 'hit')).toBe(1);
    expect(count('webhooks', 'miss')).toBe(2);
    await sleep(1100);
    expect(await cache.get('T1', 'webhooks', 'active', 'short', load('e'))).toEqual({ v: 'e' });
    await cache.invalidate({ tenantId: 'T1', ns: 'plugins' });
    expect(await cache.get('T1', 'plugins', 'enabled', 'medium', load('f'))).toEqual({ v: 'f' });
    await expect(cache.get('T1', 'Bad NS', 'k', 'short', load('x'))).rejects.toThrow(/namespace/);
    await cache.close();
    await bus.close();
  });

  it('a bus invalidation on one instance clears the entry on another', async () => {
    const redis = await new MiniRedis().start();
    const busA = new Bus(log, redis.url);
    const busB = new Bus(log, redis.url);
    const a = new TenantCache(new MemoryCacheStore(), busA, new Registry(), { ttlSeconds: ttl });
    const b = new TenantCache(new MemoryCacheStore(), busB, new Registry(), { ttlSeconds: ttl });
    try {
      await until(() => redis.commands.filter((c) => c[0]!.toUpperCase() === 'SUBSCRIBE').length >= 2);
      let version = 1;
      const read = (c: TenantCache) => c.get('T1', 'profiles', 'general', 'long', async () => ({ version }));
      expect(await read(a)).toEqual({ version: 1 });
      expect(await read(b)).toEqual({ version: 1 });
      version = 2;
      expect(await read(b)).toEqual({ version: 1 }); // cached on B
      await a.invalidate({ tenantId: 'T1', ns: 'profiles', key: 'general' });
      await until(async () => (await read(b)).version === 2);
      expect(await read(a)).toEqual({ version: 2 });

      // invalidated by a domain's own bus topic, published on A
      b.invalidateOn<{ tenantId: string }>(TOPICS.pluginChanged, (e) => [{ tenantId: e.tenantId, ns: 'profiles' }]);
      version = 3;
      busA.publish(TOPICS.pluginChanged, { tenantId: 'T1', pluginId: 'x' });
      await until(async () => (await read(b)).version === 3);
    } finally {
      await a.close();
      await b.close();
      await busA.close();
      await busB.close();
      await redis.stop();
    }
  });

  it('shares entries through Redis when configured, and falls back to the loader when Redis fails', async () => {
    const redis = await new MiniRedis().start();
    const bus = new Bus(log);
    const one = new TenantCache(new RedisCacheStore(redis.url), bus, new Registry(), { ttlSeconds: ttl });
    const two = new TenantCache(new RedisCacheStore(redis.url), bus, new Registry(), { ttlSeconds: ttl });
    try {
      let n = 0;
      const load = async () => ({ n: ++n });
      expect(await one.get('T1', 'webhooks', 'active', 'medium', load)).toEqual({ n: 1 });
      expect(await two.get('T1', 'webhooks', 'active', 'medium', load)).toEqual({ n: 1 }); // shared
      expect(redis.keys().some((k) => k.startsWith('exprsn:cache:T1:webhooks:0:active'))).toBe(true);
      expect(redis.commands.some((c) => c[0]!.toUpperCase() === 'SET' && c.map((x) => x.toUpperCase()).includes('PX') && c.includes('60000'))).toBe(true);
      await two.invalidate({ tenantId: 'T1', ns: 'webhooks' }); // a namespace: its generation moves on
      expect(await one.get('T1', 'webhooks', 'active', 'medium', load)).toEqual({ n: 2 });
    } finally {
      await one.close();
      await two.close();
      await redis.stop();
    }
    const reg = new Registry();
    const dead = new TenantCache(new RedisCacheStore('redis://127.0.0.1:9'), bus, reg, { ttlSeconds: ttl });
    expect(await dead.get('T1', 'webhooks', 'active', 'short', async () => 'from source')).toBe('from source');
    expect((await reg.getSingleMetric('exprsn_cache_errors_total')!.get()).values.length).toBeGreaterThan(0);
    await dead.close();
    await bus.close();
  });
});

// ---------- B-2103 ----------

describe('CLI: plugins and events replay (B-2103)', () => {
  let h: Harness;
  let out: string;
  const write = (t: string) => void (out += t);
  let dir: string;
  beforeEach(async () => {
    h = await harness({ WEBHOOK_RETRY_BASE_MS: '10' });
    out = '';
    dir = mkdtempSync(path.join(tmpdir(), 'exprsn-cli-'));
  });
  afterEach(async () => {
    await h.close();
  });

  it('manages a plugin from a manifest file against the database, audited as the CLI', async () => {
    const file = path.join(dir, 'manifest.yaml');
    writeFileSync(file, 'key: flag-notifier\nname: Flag notifier\nversion: 1.0.0\nkind: declarative\nevents: ["flag.*"]\ncapabilities: [read:events, emit:notification, call:webhook]\nactions:\n  - type: notify\n    on: flag.created\n');
    expect(await pluginsCommand(h.s, ['validate', '--manifest', file], write)).toBe(0);
    expect(out).toMatch(/Valid: flag-notifier 1.0.0/);
    expect(await pluginsCommand(h.s, ['install', '--manifest', file], write)).toBe(0);
    expect(await pluginsCommand(h.s, ['enable', 'flag-notifier'], write)).toBe(3);
    expect(out).toMatch(/needs call:webhook granted/);
    expect(await pluginsCommand(h.s, ['grants', 'flag-notifier', '--grant', 'read:events', '--grant', 'emit:notification', '--grant', 'call:webhook'], write)).toBe(0);
    expect(await pluginsCommand(h.s, ['enable', 'flag-notifier', '--reason', 'approved'], write)).toBe(0);
    out = '';
    expect(await pluginsCommand(h.s, ['list'], write)).toBe(0);
    expect(out).toMatch(/flag-notifier\s+1\.0\.0\s+enabled/);
    expect(await pluginsCommand(h.s, ['disable', 'flag-notifier'], write)).toBe(0);
    expect(await pluginsCommand(h.s, ['remove', 'flag-notifier'], write)).toBe(0);
    out = '';
    expect(await pluginsCommand(h.s, ['show', 'flag-notifier'], write)).toBe(0);
    expect(JSON.parse(out).transitions.map((t: { event: string }) => t.event)).toEqual(['install', 'grants', 'enable', 'disable', 'remove']);
    const bad = path.join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify(manifest({ capabilities: ['exec:shell'] })));
    out = '';
    expect(await pluginsCommand(h.s, ['install', '--manifest', bad], write)).toBe(1);
    expect(out).toMatch(/exec:shell/);
    expect(await pluginsCommand(h.s, ['install', '--manifest', file, '--tenant', 'nowhere'], write)).toBe(1);
    expect(await pluginsCommand(h.s, ['frobnicate'], write)).toBe(64);
    const rows = (await h.s.db('audit_events').where('action', 'like', 'plugin.%').orderBy('seq')) as { action: string; actor: string }[];
    expect(rows.map((r) => r.action)).toEqual(['plugin.installed', 'plugin.grants.updated', 'plugin.enabled', 'plugin.disabled', 'plugin.removed']);
    expect(JSON.parse(rows[0]!.actor)).toEqual({ service: 'cli' });
  });

  it('replays deliveries and backfills audit events a webhook never received', async () => {
    const { row: w } = await h.s.webhooks.create(h.tenantId, 'test', { name: 'ledger', url: 'http://127.0.0.1:9/hook', events: ['demo.*', 'flag.*'], maxLabel: 'internal' });
    await h.s.webhooks.emit(h.tenantId, 'demo.one', 'internal', 'ev-1', { i: 1 });
    await h.s.webhooks.emit(h.tenantId, 'demo.two', 'internal', 'ev-2', { i: 2 });
    await h.s.webhooks.emit(h.tenantId, 'flag.created', 'internal', 'flag-event:1', { flag: 'F-1', id: '1', action: 'created', severity: 'low', checkpoint: 'user-input' });
    expect(await eventsCommand(h.s, ['replay', '--webhook', w.id, '--type', 'demo.*', '--dry-run'], write)).toBe(0);
    expect(out).toMatch(/Would replay 2 deliveries/);
    expect(await h.s.db('webhook_deliveries').whereNotNull('replay_of')).toHaveLength(0);
    out = '';
    expect(await eventsCommand(h.s, ['replay', '--webhook', w.id, '--since', '1h'], write)).toBe(0);
    expect(out).toMatch(/Replayed 3 of 3 deliveries/);
    const replays = (await h.s.db('webhook_deliveries').whereNotNull('replay_of')) as { event_id: string; payload: string; id: string }[];
    expect(replays.map((r) => r.event_id).sort()).toEqual(['ev-1', 'ev-2', 'flag-event:1']);
    // a replay repeats the original body exactly
    const original = (await h.s.db('webhook_deliveries').where({ event_id: 'ev-1' }).whereNull('replay_of').first()) as { id: string; payload: string };
    const replay = replays.find((r) => r.event_id === 'ev-1')!;
    expect(await h.s.keys.open(h.tenantId, replay.payload, `webhook-delivery:${replay.id}`)).toBe(await h.s.keys.open(h.tenantId, original.payload, `webhook-delivery:${original.id}`));

    // audit backfill for a webhook created after the fact, within its event list
    await h.s.audit.append({ tenantId: h.tenantId, action: 'user.created', kind: 'admin', actor: { service: 'test' }, target: { user: 'u1' } });
    await h.s.audit.append({ tenantId: h.tenantId, action: 'auth.login', kind: 'auth', actor: { service: 'test' }, target: {} });
    const { row: late } = await h.s.webhooks.create(h.tenantId, 'test', { name: 'late', url: 'http://127.0.0.1:9/late', events: ['user.*'], maxLabel: 'internal' });
    await h.s.db('webhook_deliveries').where({ webhook_id: late.id }).delete(); // as if it had missed them
    out = '';
    expect(await eventsCommand(h.s, ['replay', '--webhook', late.id, '--source', 'audit'], write)).toBe(0);
    expect(out).toMatch(/Queued 1 audit events/);
    const back = (await h.s.db('webhook_deliveries').where({ webhook_id: late.id })) as { id: string; event: string; payload: string }[];
    expect(back.map((d) => d.event)).toEqual(['user.created']);
    expect(validateEvent(JSON.parse(await h.s.keys.open(h.tenantId, back[0]!.payload, `webhook-delivery:${back[0]!.id}`)))).toEqual([]);
    out = '';
    expect(await eventsCommand(h.s, ['replay', '--webhook', late.id, '--source', 'audit'], write)).toBe(0);
    expect(out).toMatch(/Queued 0 audit events to late; 1 it already had were skipped/);
    expect((await h.s.db('audit_events').where({ action: 'webhook.replayed' })).length).toBe(3);

    expect(await eventsCommand(h.s, ['replay'], write)).toBe(1);
    expect(await eventsCommand(h.s, ['replay', '--webhook', w.id, '--source', 'audit', '--state', 'failed'], write)).toBe(1);
    expect(await eventsCommand(h.s, ['nope'], write)).toBe(64);
    expect(parseTime('2h', 10 * 3_600_000)).toBe(8 * 3_600_000);
    expect(() => parseTime('yesterday')).toThrow(/Not a time/);
  });
});

// ---------- B-2104 ----------

describe('migration discipline (B-2104)', () => {
  it('registers 026c_core, and migrate --check reports the database up to date', async () => {
    const h = await harness();
    try {
      const r = await migrateCheck(h.s.db);
      // The newest registered migration (later sprints add theirs after 026c_core).
      const names = await migrationSource.getMigrations([]);
      expect(r).toMatchObject({ state: 'current', pending: [], database: names.at(-1) });
      expect(names).toContain('026c_core');
      expect(await h.s.db.schema.hasTable('plugins')).toBe(true);
      expect(await h.s.db.schema.hasTable('plugin_transitions')).toBe(true);
    } finally {
      await h.close();
    }
  });
});
