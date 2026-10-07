import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';

describe('B-4701: held form values', () => {
  let h: Harness;
  let wsId: string;
  beforeEach(async () => {
    h = await harness({ APPS_PUBLIC_FORM_PER_MINUTE: '50', APPS_HELD_MAX_PER_FORM: '2' });
    wsId = (await h.s.tenants.createWorkspace(h.tenantId, 'Sales', 'confidential')).id;
  });
  afterEach(async () => {
    await h.close();
  });

  async function wrap(c: { agent: Client['agent']; csrf: string }, switchTo = true) {
    const send = (method: 'post' | 'patch' | 'put' | 'delete', path: string, body: object = {}) => c.agent[method](path).set('x-csrf-token', c.csrf).send(body);
    if (switchTo) await send('put', '/api/me/workspace', { workspaceId: wsId }).expect(200);
    return { ...c, post: (p: string, b?: object) => send('post', p, b), put: (p: string, b?: object) => send('put', p, b), get: (p: string) => c.agent.get(p) };
  }
  async function admin(name: string, roles: string[], clearance: 'internal' | 'confidential' = 'confidential', inWorkspace = true) {
    const u = await localUser(h, name, roles, clearance);
    if (inWorkspace) await h.s.tenants.addMember(wsId, u.id);
    const mfa = roles.some((r) => r !== 'member' && r !== 'flag-reviewer');
    return { user: u, ...(await wrap(mfa ? await loginAdmin(h, name) : await login(h, name), inWorkspace)) };
  }

  /** An app with a public form, and a tenant rule holding "wire transfer" at user-input. */
  async function setup() {
    const d = await admin('dee', ['workflow-admin', 'member']);
    await d.post('/api/apps', { name: 'crm', title: 'CRM', label: 'confidential', workspaceId: wsId }).expect(201);
    await d.post('/api/apps/crm/entities', { name: 'lead', label: 'internal', definition: { fields: [{ name: 'email', type: 'string', required: true, maxLength: 200 }, { name: 'note', type: 'string', multiline: true }] } }).expect(201);
    await d.post('/api/apps/crm/forms', { name: 'contact', title: 'Contact us', entity: 'lead', definition: { fields: [{ field: 'email' }, { field: 'note' }] }, ratePerMinute: 100 }).expect(201);
    const pub = (await d.post('/api/apps/crm/forms/contact/public', { enabled: true }).expect(200)).body as { token: string };
    const ga = await admin('ga', ['guardrail-admin']);
    const set = (await ga.post('/api/admin/guardrails/sets', { name: 'Form rules', scope: 'tenant' }).expect(201)).body;
    await ga.put(`/api/admin/guardrails/sets/${set.id}/draft`, { rules: [{ id: 'wire', name: 'Wire transfers', checkpoint: 'user-input', type: 'pattern', mechanism: { kind: 'pattern', pattern: '(?i)wire transfer' }, action: 'require-approval', stage: 'enforce' }] }).expect(200);
    await ga.post(`/api/admin/guardrails/sets/${set.id}/draft/publish`).expect(200);
    return { d, ga, token: pub.token };
  }

  it('a held public submission is queued, appears in the moderation queue and is accepted into a record from there', async () => {
    const { d, ga, token } = await setup();
    // A moderation queue for holds.
    const q = (await ga.post('/api/moderation/queues', { name: 'Held forms', kinds: ['hold'], workspaceId: wsId, slaMinutes: 60, escalateTo: 'tenant' }).expect(201)).body;
    const anon = request(h.app);
    // An unheld submission is written at once, as before.
    await anon.post('/api/public/forms/submit').send({ token, values: { email: 'a@x.test', note: 'Hello' } }).expect(201);
    // A held one waits for review instead of being refused.
    const sub = (await anon.post('/api/public/forms/submit').send({ token, values: { email: 'b@x.test', note: 'Please send the wire transfer today', extra: 1 } }).expect(202)).body;
    expect(sub).toMatchObject({ submitted: true, held: true, dropped: 1 });
    expect(sub.message).toMatch(/reviewed/);
    expect(await h.s.db('app_records').where({ source: 'form' })).toHaveLength(1);
    const row = await h.s.db('app_form_holds').first();
    expect(row).toMatchObject({ state: 'held', label: 'internal' });
    expect(row.values_sealed).not.toContain('wire'); // sealed with the tenant key
    expect(row.ip_hash).toMatch(/^[0-9a-f]{64}$/);

    // It appears in the moderation queue, routed there by its kind.
    const queue = (await ga.get(`/api/moderation/queues/${q.id}/flags`).expect(200)).body;
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]).toMatchObject({ kind: 'hold', object: { type: 'app-form-submission', id: row.id, hideable: false } });
    // The reviewer reads the values there.
    const list = (await ga.get('/api/apps/held').expect(200)).body.items;
    expect(list).toEqual([expect.objectContaining({ id: row.id, state: 'held', form: expect.objectContaining({ title: 'Contact us' }), held: [expect.objectContaining({ field: 'note', rule: 'Wire transfers' })], flag: expect.objectContaining({ ref: queue.items[0].ref, queueId: q.id }) })]);
    const detail = (await ga.get(`/api/apps/held/${row.id}`).expect(200)).body;
    expect(detail.values).toEqual({ email: 'b@x.test', note: 'Please send the wire transfer today' });
    // The Flags screen shows the held values too.
    expect((await ga.get(`/api/flags/${queue.items[0].ref}`).expect(200)).body.held.content).toContain('note: Please send the wire transfer today');

    // Someone without a review permission sees nothing.
    const m = await admin('mia', ['member'], 'internal');
    await m.get('/api/apps/held').expect(403);
    // A reviewer outside the app's workspace gets a 404.
    const outsider = await admin('otto', ['flag-reviewer'], 'confidential', false);
    expect((await outsider.agent.get('/api/apps/held').expect(200)).body.items).toEqual([]);
    await outsider.agent.get(`/api/apps/held/${row.id}`).expect(404);

    // Accepted from the moderation queue: the record is written by no one, as a public submission is.
    const dec = (await ga.post(`/api/apps/held/${row.id}/decide`, { decision: 'accept', reason: 'A customer asking about payment' }).expect(200)).body;
    expect(dec).toMatchObject({ state: 'accepted', flag: { state: 'approved' } });
    const rec = await h.s.db('app_records').where({ id: dec.recordId }).first();
    expect(rec).toMatchObject({ source: 'form', created_by: null });
    expect((await d.get(`/api/apps/crm/entities/lead/records/${dec.recordId}`).expect(200)).body.values).toEqual({ email: 'b@x.test', note: 'Please send the wire transfer today' });
    const after = await h.s.db('app_form_holds').where({ id: row.id }).first();
    expect(after).toMatchObject({ state: 'accepted', record_id: dec.recordId, values_sealed: null, decided_by: ga.user.id });
    await ga.post(`/api/apps/held/${row.id}/decide`, { decision: 'reject' }).expect(409);
    expect((await ga.get(`/api/moderation/queues/${q.id}/flags`).expect(200)).body.items).toHaveLength(0);
    const actions = (await h.s.db('audit_events').where({ tenant_id: h.tenantId }).where('action', 'like', 'app.form.%').select('action')).map((x: { action: string }) => x.action);
    expect(actions).toEqual(expect.arrayContaining(['app.form.submitted', 'app.form.held', 'app.form.held.accepted']));
  });

  it('a rejected one writes nothing; the Flags decide route works too; a full queue refuses as before', async () => {
    const { ga, token } = await setup();
    const anon = request(h.app);
    await anon.post('/api/public/forms/submit').send({ token, values: { email: 'c@x.test', note: 'wire transfer one' } }).expect(202);
    await anon.post('/api/public/forms/submit').send({ token, values: { email: 'd@x.test', note: 'wire transfer two' } }).expect(202);
    // APPS_HELD_MAX_PER_FORM=2: a third held submission is refused, as before 1.6.0.
    const full = (await anon.post('/api/public/forms/submit').send({ token, values: { email: 'e@x.test', note: 'wire transfer three' } }).expect(422)).body;
    expect(full.step).toBe('held-queue-full');
    const [one, two] = (await ga.get('/api/apps/held').expect(200)).body.items as { id: string; flag: { ref: string } }[];
    await ga.post(`/api/apps/held/${one!.id}/decide`, { decision: 'reject', reason: 'Spam' }).expect(200);
    expect(await h.s.db('app_records')).toHaveLength(0);
    expect((await h.s.db('app_form_holds').where({ id: one!.id }).first()).values_sealed).toBeNull();
    // The Flags screen's decide route accepts the other.
    await ga.post(`/api/flags/${two!.flag.ref}/decide`, { decision: 'approved' }).expect(200);
    expect(await h.s.db('app_records').where({ source: 'form' })).toHaveLength(1);
    expect((await h.s.db('app_form_holds').where({ id: two!.id }).first()).state).toBe('accepted');
    // A signed-in submission is still refused (only public submissions wait).
    const d = await admin('dan', ['member'], 'internal');
    await d.post('/api/apps/crm/forms/contact/submit', { values: { email: 'f@x.test', note: 'wire transfer' } }).expect(422);
    // Decided submissions are deleted after APPS_HELD_KEEP_DAYS.
    await h.s.db('app_form_holds').update({ decided_at: Date.now() - 31 * 86_400_000 });
    expect(await h.s.apps.forms.held.purge()).toEqual({ deleted: 2 });
  });
});
