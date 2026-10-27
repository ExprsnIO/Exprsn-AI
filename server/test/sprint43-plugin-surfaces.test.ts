import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { surfaceProblems, surfaceSchema } from '../src/plugins/surfaces.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';

/*
 * Sprint 43 (1.7.0), B-112: plugin UI surfaces (declarative; docs/decisions/plugin-ui-surfaces.md). The "done
 * when" of B-11202 is the test below: a surface calling a capability its plugin was not granted is refused, and a
 * surface never reads data above the viewer's clearance. (B-11203's console checks are in e2e/tests/plugin-surfaces.spec.ts.)
 */

/** The fixture plugin: a settings panel and a side panel beside a deal record. */
export const FIXTURE = {
  key: 'deal-notes',
  name: 'Deal notes',
  version: '1.0.0',
  kind: 'declarative',
  capabilities: ['read:records', 'write:records'],
  optionalCapabilities: ['write:records'],
  ui: [
    { id: 'about', slot: 'settings', title: 'Deal notes', blocks: [{ type: 'text', text: 'Shows a summary of a deal beside it.' }] },
    {
      id: 'deal-summary',
      slot: 'record',
      title: 'Deal summary',
      app: 'crm',
      entity: 'deal',
      capabilities: ['read:records'],
      data: { deal: { api: 'records.read', with: { app: 'crm', entity: 'deal', id: '{{context.record}}' } } },
      blocks: [
        { type: 'text', text: 'From the record you are looking at.' },
        { type: 'kv', data: 'deal', items: [{ label: 'Title', path: 'record.values.title' }, { label: 'Amount', path: 'record.values.amount' }] }
      ]
    },
    {
      id: 'deal-close',
      slot: 'record',
      title: 'Close the deal',
      app: 'crm',
      entity: 'deal',
      capabilities: ['write:records'],
      actions: { close: { api: 'records.write', with: { app: 'crm', entity: 'deal', action: 'update', id: '{{context.record}}', values: { amount: 0 } } } },
      blocks: [{ type: 'action', label: 'Zero the amount', action: 'close', confirm: 'Set the amount to zero?' }]
    }
  ]
};

describe('plugin UI surfaces (Sprint 43, B-112)', () => {
  let h: Harness;
  let admin: Client & { send: (m: 'post' | 'put' | 'delete', p: string, b?: object) => ReturnType<Client['agent']['post']> };

  beforeEach(async () => {
    h = await harness();
    await localUser(h, 'pa', ['tenant-admin'], 'restricted');
    const c = await loginAdmin(h, 'pa');
    admin = { ...c, send: (m, p, b = {}) => c.agent[m](p).set('x-csrf-token', c.csrf).send(b) };
  });
  afterEach(async () => {
    await h.close();
  });

  it('checks a manifest\'s surfaces against its capabilities and its slots', () => {
    const parse = (ui: object[]) => surfaceProblems(ui.map((u) => surfaceSchema.parse(u)), ['read:records']);
    expect(parse(FIXTURE.ui.slice(0, 2))).toEqual([]);
    expect(parse([{ ...FIXTURE.ui[1], capabilities: ['read:files'] }]).join('\n')).toMatch(/read:files is not among the capabilities|needs read:records/);
    expect(parse([{ ...FIXTURE.ui[1], data: { deal: { api: 'records.read', with: { id: '{{context.file}}' } } } }]).join('\n')).toMatch(/is not something the record slot provides/);
    expect(parse([{ id: 'x', slot: 'settings', title: 'X', blocks: [{ type: 'kv', data: 'nope', items: [{ label: 'a', path: 'a' }] }] }]).join('\n')).toMatch(/not under data/);
    expect(() => surfaceSchema.parse({ id: 'x', slot: 'settings', title: 'X', blocks: [{ type: 'html', html: '<script>' }] })).toThrow();
  });

  it('B-11202: a surface calling a capability its plugin was not granted is refused; a surface never reads above the viewer', async () => {
    // the app and two deals: one internal, one confidential
    const crm = (await admin.send('post', '/api/apps', { name: 'crm', label: 'confidential', workspaceId: null }).expect(201)).body;
    await admin.send('post', '/api/apps/crm/entities', { name: 'deal', label: 'internal', definition: { fields: [{ name: 'title', type: 'string', maxLength: 120 }, { name: 'amount', type: 'number' }] } }).expect(201);
    const open = (await admin.send('post', '/api/apps/crm/entities/deal/records', { values: { title: 'Northwind renewal', amount: 1200 }, label: 'internal' }).expect(201)).body;
    const secret = (await admin.send('post', '/api/apps/crm/entities/deal/records', { values: { title: 'Acquisition', amount: 9000000 }, label: 'confidential' }).expect(201)).body;
    expect(crm.name).toBe('crm');


    // a manifest whose surface calls what it does not declare is refused at install
    const bad = { ...FIXTURE, key: 'bad-notes', ui: [{ ...FIXTURE.ui[1], capabilities: [] }] };
    expect((await admin.send('post', '/api/admin/plugins', { manifest: bad, maxLabel: 'confidential' })).status).toBeGreaterThanOrEqual(400);

    // installed with read:records only; nothing shows until a surface is approved
    const plugin = (await admin.send('post', '/api/admin/plugins', { manifest: FIXTURE, grants: ['read:records'], maxLabel: 'confidential' }).expect(201)).body;
    await admin.send('post', `/api/admin/plugins/${plugin.id}/enable`, { reason: 'test' }).expect((r) => expect(r.status).toBeLessThan(300));
    const viewer = await (async () => {
      await localUser(h, 'vic', ['member'], 'internal');
      return login(h, 'vic');
    })();
    const slot = async (c: Client) => (await c.agent.get('/api/plugin-surfaces?slot=record&app=crm&entity=deal').expect(200)).body as { id: string; blocks: unknown[] }[];
    expect(await slot(viewer)).toEqual([]);
    const list = (await admin.agent.get(`/api/admin/plugins/${plugin.id}/surfaces`).expect(200)).body as { id: string; approved: boolean; missingGrants: string[] }[];
    expect(list.map((x) => [x.id, x.approved, x.missingGrants])).toEqual([['about', false, []], ['deal-summary', false, []], ['deal-close', false, ['write:records']]]);

    // the write surface cannot be approved: its capability is not granted
    expect((await admin.send('put', `/api/admin/plugins/${plugin.id}/surfaces/deal-close`, { approve: true }).expect(409)).body.detail).toMatch(/write:records/);
    await admin.send('put', `/api/admin/plugins/${plugin.id}/surfaces/deal-summary`, { approve: true }).expect(200);
    expect((await slot(viewer)).map((x) => x.id)).toEqual(['deal-summary']);
    expect((await viewer.agent.get('/api/plugin-surfaces?slot=record&app=other&entity=deal').expect(200)).body).toEqual([]);

    // the bridge runs the declared call as the viewer: the internal deal reads, the confidential one does not
    const call = (c: Client, record: string, kind = 'data', id = 'deal', surface = 'deal-summary') => c.agent.post(`/api/plugin-surfaces/${plugin.id}/${surface}/${kind === 'action' ? 'actions' : kind}/${id}`).set('x-csrf-token', c.csrf).send({ context: { record } });
    expect((await call(viewer, open.id).expect(200)).body.record.values).toMatchObject({ title: 'Northwind renewal', amount: 1200 });
    expect((await call(viewer, secret.id)).status).toBeGreaterThanOrEqual(403);
    // the admin, cleared for it, reads it through the same surface
    expect((await call(admin, secret.id).expect(200)).body.record.values.title).toBe('Acquisition');
    // a call the surface does not declare, or a context the slot does not give, goes nowhere
    await call(viewer, open.id, 'data', 'everything').expect(404);
    await viewer.agent.post(`/api/plugin-surfaces/${plugin.id}/deal-summary/data/deal`).set('x-csrf-token', viewer.csrf).send({ context: {} }).expect(400);
    // an unapproved surface's action is refused even though it is declared
    await call(admin, open.id, 'action', 'close', 'deal-close').expect(404);

    // a required grant taken back disables the plugin: nothing of it shows or answers
    await admin.send('put', `/api/admin/plugins/${plugin.id}/grants`, { grants: [], reason: 'test' }).expect(200);
    await call(viewer, open.id).expect(404);
    expect(await slot(viewer)).toEqual([]);
    await admin.send('put', `/api/admin/plugins/${plugin.id}/grants`, { grants: ['read:records'], reason: 'test' }).expect(200);
    await admin.send('post', `/api/admin/plugins/${plugin.id}/enable`, { reason: 'test' }).expect((r) => expect(r.status).toBeLessThan(300));
    expect((await slot(viewer)).map((x) => x.id)).toEqual(['deal-summary']);

    // the write surface, once its capability is granted and it is approved, acts as the viewer; an optional grant
    // taken back after approval refuses its call for that capability while the plugin stays enabled
    await admin.send('put', `/api/admin/plugins/${plugin.id}/grants`, { grants: ['read:records', 'write:records'], reason: 'test' }).expect(200);
    await admin.send('put', `/api/admin/plugins/${plugin.id}/surfaces/deal-close`, { approve: true }).expect(200);
    expect((await call(viewer, open.id, 'action', 'close', 'deal-close').expect(200)).body).toMatchObject({ id: open.id });
    expect((await h.s.db('audit_events').where({ action: 'plugin.surface.action' })).length).toBe(1);
    await admin.send('put', `/api/admin/plugins/${plugin.id}/grants`, { grants: ['read:records'], reason: 'test' }).expect(200);
    expect((await call(viewer, open.id, 'action', 'close', 'deal-close').expect(403)).body.step).toBe('capability');
    expect((await slot(viewer)).map((x) => x.id)).toEqual(['deal-summary']);

    // disabling removes it at once
    await admin.send('put', `/api/admin/plugins/${plugin.id}/surfaces/deal-summary`, { enabled: false }).expect(200);
    expect(await slot(viewer)).toEqual([]);
    await call(viewer, open.id).expect(404);
    expect((await h.s.db('audit_events').whereIn('action', ['plugin.surface.approved', 'plugin.surface.disabled'])).length).toBe(3);
  });
});
