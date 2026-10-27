import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type request from 'supertest';
import { io as ioClient, type Socket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPrincipal } from '../src/http/middleware.js';
import { DesignLocks } from '../src/realtime/design-locks.js';
import { attachRealtime } from '../src/realtime/socket.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';

/*
 * 1.8.0, Sprint 47 (B-140): presence and soft locks in the designers (migration 098_design_locks).
 *
 * The lock is taken, renewed and expires; another editor's save is refused with 409 naming the holder, and the
 * holder's save releases it; someone with the manage right takes it over (the holder's socket is told and the holder's
 * next save is refused); a tenant admin breaks it; every step is audited design.lock.*. Presence is decided from the
 * socket's principal: two editors see each other, a socket below the object's clearance is refused and hears nothing,
 * and a disconnect removes the viewer and releases the lock. Several instances share the rows: a second DesignLocks on
 * the same database (as another instance would be) sees the same viewers and loses the race for a held lock, and the
 * rows of an instance that went away are swept. (sprint22-fakes.ts's FakeRedis answers counters only, not pub/sub,
 * so the instances here share the bus in process, as Redis would join them.)
 */

type Api = Client & { post: (p: string, b?: object) => request.Test; put: (p: string, b?: object) => request.Test; del: (p: string) => request.Test; get: (p: string) => request.Test };
const graph = { nodes: [{ id: 'trigger', kind: 'trigger', title: 'Trigger', x: 20, y: 20, config: { source: 'manual' } }], edges: [], limits: {} };

describe('design presence and edit locks (B-140)', () => {
  let h: Harness;
  let server: Server;
  let url: string;
  let wsId: string;
  let wren: Api;
  let tia: Api;
  let ada: Api;
  let lou: Api;
  const sockets: Socket[] = [];

  const api = (c: Client): Api => {
    const send = (method: 'post' | 'put', path: string, body: object = {}) => c.agent[method](path).set('x-csrf-token', c.csrf).send(body);
    return { ...c, post: (p, b) => send('post', p, b), put: (p, b) => send('put', p, b), del: (p) => c.agent.delete(p).set('x-csrf-token', c.csrf), get: (p) => c.agent.get(p) };
  };

  beforeEach(async () => {
    h = await harness({ OLLAMA_POLL_MS: '600000' });
    h.s.designLocks.opts.sweepMs = 0;
    server = createServer(h.app);
    attachRealtime(server, h.s);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    wsId = (await h.s.tenants.createWorkspace(h.tenantId, 'Ops', 'confidential')).id;
    const ids = [(await localUser(h, 'wren', ['workflow-admin', 'member'], 'confidential')).id, (await localUser(h, 'tia', ['workflow-admin', 'member'], 'confidential')).id, (await localUser(h, 'ada', ['tenant-admin', 'member'], 'confidential')).id, (await localUser(h, 'lou', ['member'], 'internal')).id];
    for (const id of ids) await h.s.tenants.addMember(wsId, id);
    wren = api(await loginAdmin(h, 'wren'));
    tia = api(await loginAdmin(h, 'tia'));
    ada = api(await loginAdmin(h, 'ada'));
    const l = await login(h, 'lou');
    lou = api({ agent: l.agent, csrf: l.csrf, cookie: l.cookie });
    for (const c of [wren, tia, ada, lou]) await c.put('/api/me/workspace', { workspaceId: wsId }).expect(200);
  });
  afterEach(async () => {
    for (const x of sockets.splice(0)) x.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await h.close();
  });

  const workflow = async (name: string, label = 'internal') => (await wren.post('/api/workflows', { name, label, graph }).expect(201)).body as { id: string; draftRev: number };
  const audits = async (action: string) => (await h.s.db('audit_events').where({ action })) as { detail: string; actor: string }[];
  const until = async (fn: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!fn()) {
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  async function connect(c: Client) {
    const sock = ioClient(url, { path: '/socket.io', transports: ['websocket'], reconnection: false, extraHeaders: { cookie: c.cookie } });
    sockets.push(sock);
    await new Promise((r) => sock.on('ready', r));
    const got: { event: string; data: Record<string, unknown> }[] = [];
    sock.onAny((event: string, data: Record<string, unknown>) => void got.push({ event, data }));
    const ask = <T = Record<string, unknown>>(ev: string, msg: object) => new Promise<T>((r) => sock.emit(ev, msg, r));
    return { sock, got, ask };
  }

  it('takes, renews and expires the lock; a save without it is refused and the holder’s save releases it', async () => {
    const w = await workflow('expenses');
    const L = `/api/design-locks/workflow/${w.id}`;
    const first = (await wren.post(L, {}).expect(200)).body;
    expect(first.lock).toMatchObject({ name: 'WREN', via: 'api' });
    expect((await audits('design.lock.taken')).length).toBe(1);

    // Another editor: refused, with who holds it.
    const refused = await tia.post(L, {}).expect(409);
    expect(refused.body.lock).toMatchObject({ name: 'WREN' });
    expect((await tia.get(L).expect(200)).body.lock).toMatchObject({ name: 'WREN', you: false });

    // Renewed by its holder: same start, later expiry, no second audit entry.
    await new Promise((r) => setTimeout(r, 5));
    const again = (await wren.post(L, {}).expect(200)).body;
    expect(again.lock.since).toBe(first.lock.since);
    expect(again.lock.expiresAt).toBeGreaterThan(first.lock.expiresAt);
    expect((await audits('design.lock.taken')).length).toBe(1);

    // A save by someone else is refused with 409 naming the holder; the revision check is untouched.
    const save = await tia.put(`/api/workflows/${w.id}/draft`, { graph, rev: w.draftRev }).expect(409);
    expect(save.body).toMatchObject({ title: 'Being edited', lock: { name: 'WREN' } });
    expect(save.body.detail).toMatch(/WREN is editing this since/);

    // The holder saves: the lock goes.
    await wren.put(`/api/workflows/${w.id}/draft`, { graph, rev: w.draftRev }).expect(200);
    expect((await wren.get(L).expect(200)).body.lock).toBeNull();
    expect(JSON.parse((await audits('design.lock.released'))[0]!.detail)).toMatchObject({ reason: 'save' });
    // The stale revision is still the last guard.
    await tia.put(`/api/workflows/${w.id}/draft`, { graph, rev: w.draftRev }).expect(409);

    // Expiry: a lock not renewed holds nothing, and the sweep removes it with an audit entry.
    h.s.designLocks.opts.lockTtlMs = 40;
    await tia.post(L, {}).expect(200);
    await new Promise((r) => setTimeout(r, 60));
    expect((await wren.get(L).expect(200)).body.lock).toBeNull();
    await h.s.designLocks.sweep();
    expect(await h.s.db('design_locks')).toHaveLength(0);
    expect((await audits('design.lock.released')).map((a) => JSON.parse(a.detail).reason)).toContain('expired');
  });

  it('takeover with the manage right, and a tenant admin breaks a lock; both audited', async () => {
    const w = await workflow('payroll');
    const L = `/api/design-locks/workflow/${w.id}`;
    await wren.post(L, {}).expect(200);
    const over = (await tia.post(L, { takeover: true }).expect(200)).body;
    expect(over).toMatchObject({ tookOver: true, lock: { name: 'TIA' } });
    const taken = await audits('design.lock.taken_over');
    expect(taken).toHaveLength(1);
    expect(JSON.parse(taken[0]!.detail)).toMatchObject({ from: { name: 'WREN' } });
    // The previous holder's save is now refused.
    expect((await wren.put(`/api/workflows/${w.id}/draft`, { graph }).expect(409)).body.lock).toMatchObject({ name: 'TIA' });

    // A member without workflows:manage may not take it at all; a non-admin may not break it.
    await lou.post(L, {}).expect(403);
    await tia.post(`/api/admin/design-locks/workflow/${w.id}/break`, {}).expect(403);

    // The tenant admin sees the live locks and breaks this one.
    const list = (await ada.get('/api/admin/design-locks').expect(200)).body.locks;
    expect(list).toEqual([expect.objectContaining({ kind: 'workflow', id: w.id, title: 'payroll', name: 'TIA' })]);
    expect((await ada.post(`/api/admin/design-locks/workflow/${w.id}/break`, {}).expect(200)).body.broken).toMatchObject({ name: 'TIA' });
    const broken = await audits('design.lock.broken');
    expect(JSON.parse(broken[0]!.detail)).toMatchObject({ holder: { name: 'TIA' } });
    await ada.post(`/api/admin/design-locks/workflow/${w.id}/break`, {}).expect(404);
    await wren.put(`/api/workflows/${w.id}/draft`, { graph }).expect(200);
  });

  it('presence over the socket: viewers, the lock, takeover notice, release on disconnect', async () => {
    const w = await workflow('hiring');
    const a = await connect(wren);
    const b = await connect(tia);
    const opened = await a.ask<{ ok: boolean; viewers: { name: string; you: boolean }[]; canManage: boolean; lock: null }>('design.open', { kind: 'workflow', id: w.id });
    expect(opened).toMatchObject({ ok: true, canManage: true, lock: null, viewers: [{ name: 'WREN', you: true }] });
    expect((await b.ask<{ ok: boolean }>('design.open', { kind: 'workflow', id: w.id })).ok).toBe(true);
    await until(() => a.got.some((g) => g.event === 'design.state' && (g.data.viewers as unknown[]).length === 2));

    // wren starts editing: the lock is wren's from this socket; tia sees it held.
    const locked = await a.ask<{ ok: boolean; lock: { mine: boolean; via: string } }>('design.lock', { kind: 'workflow', id: w.id });
    expect(locked).toMatchObject({ ok: true, lock: { mine: true, via: 'socket' } });
    await until(() => b.got.some((g) => g.event === 'design.state' && (g.data.lock as { name?: string } | null)?.name === 'WREN'));
    const refused = await b.ask<{ ok: boolean; error: string; lock: { name: string; mine: boolean } }>('design.lock', { kind: 'workflow', id: w.id });
    expect(refused).toMatchObject({ ok: false, error: 'WREN is editing this.', lock: { name: 'WREN', mine: false } });

    // The heartbeat renews it.
    const before = Number((await h.s.db('design_locks').first('expires_at')).expires_at);
    await new Promise((r) => setTimeout(r, 5));
    expect((await a.ask<{ ok: boolean }>('design.heartbeat', { kind: 'workflow', id: w.id })).ok).toBe(true);
    expect(Number((await h.s.db('design_locks').first('expires_at')).expires_at)).toBeGreaterThan(before);

    // tia takes over: wren's socket is told.
    expect((await b.ask<{ ok: boolean; lock: { mine: boolean } }>('design.lock', { kind: 'workflow', id: w.id, takeover: true })).lock.mine).toBe(true);
    await until(() => a.got.some((g) => g.event === 'design.lock.lost'));
    expect(a.got.find((g) => g.event === 'design.lock.lost')!.data).toMatchObject({ kind: 'workflow', id: w.id, reason: 'taken_over', by: { name: 'TIA' } });

    // tia disconnects: the lock is released and the viewer goes.
    const seen = a.got.length;
    b.sock.close();
    await until(() => a.got.slice(seen).some((g) => g.event === 'design.state' && (g.data.viewers as unknown[]).length === 1 && g.data.lock === null));
    expect(JSON.parse((await audits('design.lock.released'))[0]!.detail)).toMatchObject({ reason: 'disconnect' });
    expect(await h.s.db('design_viewers')).toHaveLength(1);
  });

  it('never tells anyone about an object above their clearance', async () => {
    const secret = await workflow('board-pay', 'confidential');
    const open = await workflow('canteen');
    const a = await connect(wren);
    await a.ask('design.open', { kind: 'workflow', id: secret.id });
    await a.ask('design.lock', { kind: 'workflow', id: secret.id });
    const c = await connect(lou);
    // Refused the same way as an id that does not exist.
    expect(await c.ask('design.open', { kind: 'workflow', id: secret.id })).toEqual({ ok: false, error: 'Not available to you.' });
    expect(await c.ask('design.open', { kind: 'workflow', id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' })).toEqual({ ok: false, error: 'Not available to you.' });
    expect(await c.ask('design.lock', { kind: 'workflow', id: secret.id })).toEqual({ ok: false, error: 'Open it first.' });
    const rest = await lou.get(`/api/design-locks/workflow/${secret.id}`).expect(404);
    expect(JSON.stringify(rest.body)).not.toMatch(/WREN|board-pay/);
    await lou.get('/api/design-locks/workflow/01ARZ3NDEKTSV4RRFFQ69G5FAV').expect(404);
    // A workflow within the clearance: presence yes (agents:run), the lock no (no workflows:manage).
    expect(await c.ask('design.open', { kind: 'workflow', id: open.id })).toMatchObject({ ok: true, canManage: false });
    expect((await c.ask<{ ok: boolean; error: string }>('design.lock', { kind: 'workflow', id: open.id })).ok).toBe(false);
    // More happens on the confidential workflow; lou hears none of it.
    await a.ask('design.heartbeat', { kind: 'workflow', id: secret.id });
    await a.ask('design.unlock', { kind: 'workflow', id: secret.id });
    await new Promise((r) => setTimeout(r, 100));
    expect(c.got.filter((g) => g.event.startsWith('design.') && g.data.id === secret.id)).toEqual([]);
    // A label raised above a watcher's clearance ends the watch at the next heartbeat.
    const b = await connect(lou);
    expect((await b.ask<{ ok: boolean }>('design.open', { kind: 'workflow', id: open.id })).ok).toBe(true);
    await h.s.db('workflows').where({ id: open.id }).update({ label: 'confidential' });
    expect(await b.ask('design.heartbeat', { kind: 'workflow', id: open.id })).toEqual({ ok: false, error: 'Not available to you.' });
    await until(() => b.got.some((g) => g.event === 'design.closed'));
  });

  it('shares viewers and the lock across instances, and sweeps the rows of an instance that went away', async () => {
    const w = await workflow('benefits');
    const other = new DesignLocks(() => h.s, { viewerTtlMs: 45_000, lockTtlMs: 60_000, sweepMs: 0 });
    const pWren = (await loadPrincipal(h.s, h.tenantId, (await h.s.db('users').where({ username: 'wren' }).first('id')).id, {}))!;
    const pTia = (await loadPrincipal(h.s, h.tenantId, (await h.s.db('users').where({ username: 'tia' }).first('id')).id, {}))!;
    pWren.workspaceId = wsId;
    pTia.workspaceId = wsId;
    pWren.mfa = true;
    pTia.mfa = true;
    const obj = await h.s.designLocks.resolve(pWren, { kind: 'workflow', id: w.id });
    const a = await connect(wren);
    await a.ask('design.open', { kind: 'workflow', id: w.id });
    // tia is on the other instance.
    await other.open(pTia, obj, 'other-instance-socket');
    await until(() => a.got.some((g) => g.event === 'design.state' && (g.data.viewers as { name: string }[]).some((v) => v.name === 'TIA')));
    expect((await h.s.designLocks.viewers(h.tenantId, 'workflow', w.id)).map((v) => v.name).sort()).toEqual(['TIA', 'WREN']);

    // One lock across both: the first taker wins, the other instance reads it as held.
    expect((await other.acquire(pTia, obj, { socketId: 'other-instance-socket' })).ok).toBe(true);
    expect(await h.s.designLocks.acquire(pWren, obj, {})).toMatchObject({ ok: false, lock: { name: 'TIA' } });
    await until(() => a.got.some((g) => g.event === 'design.state' && (g.data.lock as { name?: string } | null)?.name === 'TIA'));

    // The other instance goes away without closing: its rows age out and any instance sweeps them.
    await h.s.db('design_viewers').where({ socket_id: 'other-instance-socket' }).update({ seen_at: Date.now() - 60_000 });
    await h.s.db('design_locks').update({ expires_at: Date.now() - 1 });
    const seen = a.got.length;
    await h.s.designLocks.sweep();
    expect((await h.s.designLocks.viewers(h.tenantId, 'workflow', w.id)).map((v) => v.name)).toEqual(['WREN']);
    expect(await h.s.db('design_locks')).toHaveLength(0);
    await until(() => a.got.slice(seen).some((g) => g.event === 'design.state' && (g.data.viewers as unknown[]).length === 1 && g.data.lock === null));
    await other.stop();
  });

  it('locks the app designers: entity, form and flow saves', async () => {
    const appBody = { name: 'crm', title: 'CRM', label: 'internal' };
    const app = (await wren.post('/api/apps', appBody).expect(201)).body;
    const ent = (await wren.post(`/api/apps/${app.id}/entities`, { name: 'lead', title: 'Lead', label: 'internal', definition: { fields: [{ name: 'title', type: 'string', required: true }] } }).expect(201)).body;
    const L = `/api/design-locks/app-entity/${ent.id}?app=${app.id}`;
    expect((await wren.get(L).expect(200)).body).toMatchObject({ kind: 'app-entity', title: 'Lead', lock: null });
    await wren.post(`/api/design-locks/app-entity/${ent.id}`, { app: app.id }).expect(200);
    const refused = await tia.agent.patch(`/api/apps/${app.id}/entities/${ent.id}`).set('x-csrf-token', tia.csrf).send({ title: 'Prospect' }).expect(409);
    expect(refused.body.lock).toMatchObject({ name: 'WREN' });
    await wren.agent.patch(`/api/apps/${app.id}/entities/${ent.id}`).set('x-csrf-token', wren.csrf).send({ title: 'Prospect' }).expect(200);
    expect((await wren.get(L).expect(200)).body.lock).toBeNull();

    const form = (await wren.post(`/api/apps/${app.id}/forms`, { name: 'intake', entity: 'lead', definition: { fields: [{ field: 'title' }] } }).expect(201)).body;
    await tia.post(`/api/design-locks/app-form/${form.id}`, { app: app.id }).expect(200);
    expect((await wren.agent.patch(`/api/apps/${app.id}/forms/${form.id}`).set('x-csrf-token', wren.csrf).send({ title: 'Intake' }).expect(409)).body.lock).toMatchObject({ name: 'TIA' });
    await tia.agent.patch(`/api/apps/${app.id}/forms/${form.id}`).set('x-csrf-token', tia.csrf).send({ title: 'Intake' }).expect(200);
    // A member reads the form (records:read) and so sees who edits it, but may not take the lock (apps:design).
    expect((await lou.get(`/api/design-locks/app-form/${form.id}?app=${app.id}`).expect(200)).body).toMatchObject({ canManage: false, lock: null });
    await lou.post(`/api/design-locks/app-form/${form.id}`, { app: app.id }).expect(403);

    // A flow: its own lock, and the lock on the workflow it saves, both refuse its save.
    const flowBody = { name: 'welcome', title: 'Welcome', entity: 'lead', trigger: { kind: 'record', events: ['created'] }, match: null, actions: [{ type: 'notify', roles: ['workflow-admin'], title: 'New lead' }] };
    const flow = (await wren.post(`/api/apps/${app.id}/flows`, flowBody).expect(201)).body;
    const { name: _n, ...change } = flowBody;
    await tia.post(`/api/design-locks/app-flow/${flow.id}`, { app: app.id }).expect(200);
    expect((await wren.put(`/api/apps/${app.id}/flows/${flow.id}`, change).expect(409)).body.lock).toMatchObject({ name: 'TIA' });
    await tia.del(`/api/design-locks/app-flow/${flow.id}?app=${app.id}`).expect(204);
    await tia.post(`/api/design-locks/workflow/${flow.workflowId}`, {}).expect(200);
    expect((await wren.put(`/api/apps/${app.id}/flows/${flow.id}`, change).expect(409)).body.design).toBe('workflow');
    await tia.del(`/api/design-locks/workflow/${flow.workflowId}`).expect(204);
    await wren.post(`/api/design-locks/app-flow/${flow.id}`, { app: app.id }).expect(200);
    await wren.put(`/api/apps/${app.id}/flows/${flow.id}`, change).expect(200);
    expect((await wren.get(`/api/design-locks/app-flow/${flow.id}?app=${app.id}`).expect(200)).body.lock).toBeNull();
  });
});
