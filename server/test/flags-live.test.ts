import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as ioClient, type Socket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { up as up137 } from '../src/db/migrations/137_feature_flags.js';
import { attachFlagEvents, FLAGS_EVENT } from '../src/realtime/flags.js';
import { attachRealtime } from '../src/realtime/socket.js';
import { FLAGS_TOPIC, type FlagActor } from '../src/flags/service.js';
import { Bus } from '../src/platform/bus.js';
import { harness, localUser, login, type Harness } from './helpers.js';

/*
 * 1.9.9-qa (B-169, live flag changes): a flag change on the bus becomes a `flags.changed` event on the console sockets
 * of the tenant it affects (a platform change: every socket), coalesced, emitted only on this instance (the bus already
 * reached the others), carrying no flag key and no value; the console then fetches GET /api/me/flags, evaluated for
 * the person as always.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('flags.changed rooms (unit)', () => {
  function fakeIo() {
    const sent: { room: string | '*'; ev: string; data: unknown }[] = [];
    return {
      sent,
      local: {
        to: (room: string) => ({ emit: (ev: string, data: unknown) => sent.push({ room, ev, data }) }),
        emit: (ev: string, data: unknown) => sent.push({ room: '*', ev, data })
      }
    };
  }
  const bus = () => new Bus({ warn: () => undefined, debug: () => undefined, error: () => undefined } as never);

  it('sends a tenant change to that tenant only, a platform change to everyone, with no key or value', async () => {
    const io = fakeIo();
    const b = bus();
    const { offs } = attachFlagEvents(io, b, (id) => `tenant:${id}`, { coalesceMs: 0 });
    b.publish(FLAGS_TOPIC, { tenantId: 'T1', key: 'secret-flag', value: true });
    b.publish(FLAGS_TOPIC, {});
    b.publish(FLAGS_TOPIC, null);
    await sleep(5);
    expect(io.sent.map((x) => [x.room, x.ev])).toEqual([
      ['tenant:T1', FLAGS_EVENT],
      ['*', FLAGS_EVENT],
      ['*', FLAGS_EVENT]
    ]);
    for (const x of io.sent) expect(Object.keys(x.data as object)).toEqual(['at']);
    for (const off of offs) off();
    b.publish(FLAGS_TOPIC, { tenantId: 'T1' });
    await sleep(5);
    expect(io.sent).toHaveLength(3);
  });

  it('coalesces a burst per tenant, and a platform change covers the tenants waiting', async () => {
    const io = fakeIo();
    const b = bus();
    const { offs } = attachFlagEvents(io, b, (id) => `tenant:${id}`, { coalesceMs: 30 });
    for (let i = 0; i < 5; i++) b.publish(FLAGS_TOPIC, { tenantId: 'T1' });
    b.publish(FLAGS_TOPIC, { tenantId: 'T2' });
    await sleep(80);
    expect(io.sent.map((x) => x.room).sort()).toEqual(['tenant:T1', 'tenant:T2']);
    io.sent.length = 0;
    b.publish(FLAGS_TOPIC, { tenantId: 'T1' });
    b.publish(FLAGS_TOPIC, {});
    b.publish(FLAGS_TOPIC, { tenantId: 'T3' });
    await sleep(80);
    expect(io.sent.map((x) => x.room)).toEqual(['*']);
    for (const off of offs) off();
  });
});

describe('flags.changed on the console socket', () => {
  let h: Harness;
  let server: Server;
  let url: string;
  let ta: FlagActor;
  const sockets: Socket[] = [];

  beforeEach(async () => {
    h = await harness({ OLLAMA_POLL_MS: '600000' });
    if (!(await h.s.db.schema.hasTable('feature_flags'))) await up137(h.s.db);
    h.s.flags.resetSchemaCache();
    server = createServer(h.app);
    attachRealtime(server, h.s);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const pa = await localUser(h, 'pa', ['system-admin'], 'restricted');
    const ut = await localUser(h, 'ta', ['tenant-admin'], 'confidential');
    ta = { tenantId: h.tenantId, userId: ut.id, actor: { user: ut.id, username: 'ta' } };
    const paActor: FlagActor = { tenantId: h.tenantId, userId: pa.id, actor: { user: pa.id, username: 'pa' } };
    await h.s.flags.create(paActor, { key: 'live-gate', type: 'boolean', defaultValue: false, state: 'active' });
    await h.s.flags.create(paActor, { key: 'server-secret', type: 'number', defaultValue: 4, state: 'active', client: false });
  });
  afterEach(async () => {
    for (const x of sockets.splice(0)) x.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await h.close();
  });

  async function connect(cookie: string) {
    const sock = ioClient(url, { path: '/socket.io', transports: ['websocket'], reconnection: false, extraHeaders: { cookie } });
    sockets.push(sock);
    await new Promise((r) => sock.on('ready', r));
    const heard: unknown[] = [];
    sock.on(FLAGS_EVENT, (d: unknown) => heard.push(d));
    // the flag definitions of beforeEach were platform changes: let their (coalesced) event pass first
    await sleep(400);
    heard.length = 0;
    return { sock, heard };
  }
  const until = async (fn: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!fn()) {
      if (Date.now() > end) throw new Error('timed out');
      await sleep(10);
    }
  };

  it('tells the tenant’s consoles to fetch again, with nothing in the event, and the refetch has the new value', async () => {
    await localUser(h, 'mem', ['member']);
    const mem = await login(h, 'mem');
    const a = await connect(mem.cookie);
    expect((await mem.agent.get('/api/me/flags').expect(200)).body.flags).toEqual({ 'live-gate': false });

    await h.s.flags.setValue(ta, 'live-gate', 'tenant', null, { value: true, rollout: null });
    await until(() => a.heard.length > 0);
    await sleep(400);
    // one event for the change, with no key, value or tenant in it
    expect(a.heard).toHaveLength(1);
    expect(Object.keys(a.heard[0] as object)).toEqual(['at']);
    const text = JSON.stringify(a.heard);
    for (const leak of ['live-gate', 'server-secret', 'true', h.tenantId]) expect(text).not.toContain(leak);
    // the console's refetch: its own flags, client flags only
    expect((await mem.agent.get('/api/me/flags').expect(200)).body.flags).toEqual({ 'live-gate': true });
  });

  it('reaches only the sockets of the tenant the change is for; a platform change reaches every socket', async () => {
    await localUser(h, 'mem', ['member']);
    const mem = await login(h, 'mem');
    const a = await connect(mem.cookie);
    // another tenant's change (as it would arrive over the bus from another instance): nothing here
    h.s.bus.publish(FLAGS_TOPIC, { tenantId: '01J0OTHERTENANT00000000000' });
    await sleep(500);
    expect(a.heard).toHaveLength(0);
    // this tenant's
    h.s.bus.publish(FLAGS_TOPIC, { tenantId: h.tenantId });
    await until(() => a.heard.length === 1);
    // a platform change (no tenant)
    h.s.bus.publish(FLAGS_TOPIC, {});
    await until(() => a.heard.length === 2);
    await sleep(400);
    expect(a.heard).toHaveLength(2);
  });
});
