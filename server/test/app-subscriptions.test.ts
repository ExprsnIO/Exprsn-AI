import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Principal } from '../src/authz/policy.js';
import { forbidden } from '../src/http/problem.js';
import { createLogger, Metrics } from '../src/observability/index.js';
import { createServices } from '../src/services.js';
import type { AppExportsLike, RenderRequest, RenderResult } from '../src/apps/subscriptions.js';
import { verifySignature } from '../src/webhooks/service.js';
import { nextRun } from '../src/workflows/schedules.js';
import { FakeMail, type SentMail } from './fake-account.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';
import { drain } from './retrieval-seed.js';
import { FakeReceiver } from './sprint13-fakes.js';

/*
 * 1.8.0, Sprint 44 (B-124): scheduled delivery of app views, reports and dashboards (apps/subscriptions.ts, migration
 * 104_app_subscriptions). Most tests render through a stub of `s.appExports.render` (B-123) that records who it
 * rendered as and answers with that person's own bytes; the last one uses the real renderer when this build has it.
 */

interface StubState {
  rows: number;
  big: boolean;
  fail: string | null;
  deny: Set<string>;
  calls: { user: string; req: RenderRequest }[];
  version: number;
}

function stubExports(st: StubState): AppExportsLike {
  return {
    async render(p: Principal, req: RenderRequest): Promise<RenderResult> {
      st.calls.push({ user: p.userId, req });
      if (st.fail) throw new Error(st.fail);
      if (st.deny.has(p.userId)) throw forbidden('The report reads a saved connection query; connections:query is needed.', { step: 'role' });
      const lines = ['title,amount', ...Array.from({ length: st.rows }, (_, i) => `Deal ${i},${i * 10}`), `# rendered for ${p.userId} v${st.version}`];
      const text = lines.join('\n') + (st.big ? `\n${'x'.repeat(5000)}` : '');
      return { filename: 'deals.csv', contentType: 'text/csv', bytes: Buffer.from(text), rows: st.rows, truncated: false };
    }
  };
}

describe('scheduled delivery of app views, reports and dashboards (B-124)', () => {
  let h: Harness;
  let mail: FakeMail;
  let wsId: string;
  let st: StubState;
  let hook: FakeReceiver | null = null;
  /** The build's own renderer (B-123), when it has one, before the stub replaces it. */
  let original: AppExportsLike | null = null;

  beforeEach(async () => {
    mail = new FakeMail();
    h = await harness({ APPS_DELIVERY_ATTACH_MAX_BYTES: '2048', APPS_DELIVERY_MAX_ATTEMPTS: '2', APPS_DELIVERY_PAUSE_AFTER: '2' }, { mail });
    wsId = (await h.s.tenants.createWorkspace(h.tenantId, 'Sales', 'confidential')).id;
    st = { rows: 2, big: false, fail: null, deny: new Set(), calls: [], version: 1 };
    original = (h.s as unknown as { appExports?: AppExportsLike }).appExports ?? null;
    (h.s as unknown as { appExports: AppExportsLike }).appExports = stubExports(st);
  });
  afterEach(async () => {
    await h.close();
    if (hook) await hook.stop();
    hook = null;
  });

  type C = Awaited<ReturnType<typeof wrap>> & { user: { id: string } };
  async function wrap(c: { agent: Client['agent']; csrf: string }) {
    const send = (method: 'post' | 'patch' | 'put' | 'delete', path: string, body: object = {}) => c.agent[method](path).set('x-csrf-token', c.csrf).send(body);
    await send('put', '/api/me/workspace', { workspaceId: wsId }).expect(200);
    return { ...c, post: (p: string, b?: object) => send('post', p, b), put: (p: string, b?: object) => send('put', p, b), patch: (p: string, b?: object) => send('patch', p, b), del: (p: string) => send('delete', p), get: (p: string) => c.agent.get(p) };
  }
  async function person(name: string, roles: string[], o: { admin?: boolean; member?: boolean; clearance?: 'internal' | 'confidential' } = {}): Promise<C> {
    const u = await localUser(h, name, roles, o.clearance ?? 'confidential');
    await h.s.users.update(h.tenantId, u.id, { email: `${name}@example.test` });
    if (o.member !== false) await h.s.tenants.addMember(wsId, u.id);
    const c = o.admin ? await loginAdmin(h, name) : await login(h, name);
    if (o.member === false) {
      const send = (method: 'post' | 'patch' | 'put' | 'delete', path: string, body: object = {}) => c.agent[method](path).set('x-csrf-token', c.csrf).send(body);
      return { user: u, ...c, post: (p: string, b?: object) => send('post', p, b), put: (p: string, b?: object) => send('put', p, b), patch: (p: string, b?: object) => send('patch', p, b), del: (p: string) => send('delete', p), get: (p: string) => c.agent.get(p) };
    }
    return { user: u, ...(await wrap(c)) };
  }
  /** A tenant admin who designs the app: apps:design, webhooks:manage, files:write, tenant:manage. */
  const admin = (name = 'ada') => person(name, ['tenant-admin', 'member'], { admin: true });
  const member = (name: string, o: { member?: boolean } = {}) => person(name, ['member'], o);

  async function setup(d: C): Promise<{ viewId: string }> {
    await d.post('/api/apps', { name: 'crm', title: 'CRM', label: 'confidential', workspaceId: wsId }).expect(201);
    await d.post('/api/apps/crm/entities', { name: 'deal', title: 'Deal', label: 'internal', definition: { fields: [{ name: 'title', type: 'string', required: true, maxLength: 120 }, { name: 'amount', type: 'number' }] } }).expect(201);
    const v = (await d.post('/api/apps/crm/entities/deal/views', { name: 'Open deals', shared: true, settings: {} }).expect(201)).body;
    return { viewId: v.id };
  }
  const body = (viewId: string, over: Record<string, unknown> = {}) => ({ name: 'Morning deals', app: 'crm', kind: 'view', id: viewId, format: 'csv', schedule: { preset: 'daily', values: { hour: 9, minute: 0 }, timezone: 'Europe/Berlin' }, destinations: { email: { self: true, others: [] } }, ...over });
  const audits = async (action: string) => (await h.s.db('audit_events').where({ tenant_id: h.tenantId, action })) as { target: string; detail: string | null; actor: string }[];
  const deliveries = async (subId: string) => (await h.s.db('app_subscription_deliveries').where({ subscription_id: subId }).orderBy('created_at')) as { destination: string; recipient_id: string | null; outcome: string; reason: string | null; row_count: number | null; bytes: number | null; file_id: string | null; run_id: string }[];
  const runNow = async (c: C, id: string) => {
    await c.post(`/api/apps/subscriptions/${id}/run`).expect(202);
    await drain(h);
  };
  const retryNow = async () => {
    await h.s.db('jobs').where({ type: 'apps.subscription.deliver', state: 'queued' }).update({ run_at: 0 });
    await drain(h);
  };
  /** Delivery emails only (sign-in notices and other mail go to the same addresses). */
  const dmail = (address: string) => mail.to(address).filter((m) => !!m.headers?.['List-Unsubscribe']);
  const attachmentOf = (m: SentMail) => m.attachments?.[0]?.content.toString('utf8') ?? '';

  it('stores a zoned schedule, previews it, refuses one too frequent, and claims each due time once across instances', async () => {
    const ada = await admin();
    const { viewId } = await setup(ada);
    const preview = (await ada.post('/api/apps/subscriptions/preview', { schedule: { preset: 'weekly', values: { dow: 1, hour: 8 }, timezone: 'America/New_York' }, count: 3 }).expect(200)).body;
    expect(preview).toMatchObject({ cron: '0 8 * * 1', timezone: 'America/New_York', description: expect.stringContaining('Mondays') });
    expect(preview.runs).toHaveLength(3);
    expect((await ada.post('/api/apps/subscriptions/preview', { schedule: { cron: '*/15 * * * *', timezone: 'UTC' } }).expect(422)).body.detail).toMatch(/at least 60 minutes apart/);
    await ada.post('/api/apps/subscriptions', body(viewId, { schedule: { cron: '0 9 * * *', timezone: 'Mars/Olympus' } })).expect(422);
    const opts = (await ada.get('/api/apps/subscriptions/options').expect(200)).body;
    expect(opts).toMatchObject({ formats: ['xlsx', 'pdf', 'csv', 'html'], attachMaxBytes: 2048, emailEnabled: true, renderAvailable: true });

    const sub = (await ada.post('/api/apps/subscriptions', body(viewId)).expect(201)).body;
    expect(sub).toMatchObject({ name: 'Morning deals', kind: 'view', format: 'csv', state: 'active', schedule: { cron: '0 9 * * *', preset: 'daily', timezone: 'Europe/Berlin', description: 'At 09:00, every day (Europe/Berlin)' }, destinations: { email: { self: true, others: [] }, file: null, webhook: null } });
    const row = await h.s.db('app_subscriptions').where({ id: sub.id }).first();
    expect(Number(row.next_run_at)).toBe(nextRun('0 9 * * *', Number(row.created_at), 'Europe/Berlin'));
    expect(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(Number(row.next_run_at)))).toBe('09:00');
    // The name, parameters and destinations are sealed at rest.
    expect(String(row.spec)).not.toContain('Morning deals');

    const due = Number(row.next_run_at);
    const second = createServices(h.s.cfg, h.s.db, createLogger('silent', false), new Metrics());
    (second as unknown as { appExports: AppExportsLike }).appExports = stubExports(st);
    try {
      const [x, y] = await Promise.all([h.s.apps.subscriptions.tick(due + 1), second.apps.subscriptions.tick(due + 1)]);
      expect(x.queued + y.queued).toBe(1);
      expect(await h.s.apps.subscriptions.tick(due + 1)).toEqual({ queued: 0, paused: 0 });
    } finally {
      second.workflowTriggers.close();
      second.pluginRuntime.close();
    }
    await drain(h);
    expect(await h.s.db('app_subscription_runs').where({ subscription_id: sub.id })).toHaveLength(1);
    expect(dmail('ada@example.test')).toHaveLength(1);
    const after = await h.s.db('app_subscriptions').where({ id: sub.id }).first();
    expect(Number(after.next_run_at)).toBe(nextRun('0 9 * * *', due + 1, 'Europe/Berlin'));
    expect((await audits('app.subscription.created'))[0]!.detail).not.toContain('Morning deals');
  });

  it('emails each recipient their own render, as themselves, with a signed unsubscribe link; only designers add others', async () => {
    const ada = await admin();
    const mia = await member('mia');
    const { viewId } = await setup(ada);
    // A reader may subscribe themselves, but not other people.
    await mia.post('/api/apps/subscriptions', body(viewId, { destinations: { email: { self: true, others: ['ada'] } } })).expect(403);
    const own = (await mia.post('/api/apps/subscriptions', body(viewId, { name: 'Mine' })).expect(201)).body;
    expect(own.destinations.email.others).toEqual([]);

    const sub = (await ada.post('/api/apps/subscriptions', body(viewId, { options: { message: 'Numbers for the stand-up' }, destinations: { email: { self: true, others: ['mia'] } } })).expect(201)).body;
    expect(sub.destinations.email.others).toMatchObject([{ username: 'mia', unsubscribed: false }]);
    await runNow(ada, sub.id);
    const toAda = dmail('ada@example.test');
    const toMia = dmail('mia@example.test');
    expect(toAda).toHaveLength(1);
    expect(toMia).toHaveLength(1);
    // Each render was made as its recipient: never the subscriber's data in another person's email.
    expect(attachmentOf(toAda[0]!)).toContain(`rendered for ${ada.user.id}`);
    expect(attachmentOf(toMia[0]!)).toContain(`rendered for ${mia.user.id}`);
    expect(attachmentOf(toMia[0]!)).not.toContain(ada.user.id);
    expect(st.calls.map((c) => c.user).sort()).toEqual([ada.user.id, mia.user.id].sort());
    expect(st.calls[0]!.req).toMatchObject({ kind: 'view', id: viewId, format: 'csv' });
    expect(toMia[0]!.text).toContain('A note from ADA: Numbers for the stand-up');
    expect(toMia[0]!.text).toMatch(/\/api\/public\/app-subscriptions\/unsubscribe\?t=v1\./);
    expect(toMia[0]!.headers?.['List-Unsubscribe']).toMatch(/^<http:\/\/localhost:8080\/api\/public\/app-subscriptions\/unsubscribe\?t=/);
    expect(toMia[0]!.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    // The history: time, destination, recipient, rows, size and outcome; no content.
    const hist = (await ada.get(`/api/apps/subscriptions/${sub.id}/deliveries`).expect(200)).body.deliveries;
    expect(hist).toHaveLength(2);
    expect(hist.every((x: { outcome: string; rows: number; bytes: number }) => x.outcome === 'sent' && x.rows === 2 && x.bytes > 0)).toBe(true);
    expect(JSON.stringify(await h.s.db('app_subscription_deliveries'))).not.toContain('Deal 0');
    // A recipient sees the subscription, but only their own history and not its settings.
    const seen = (await mia.get('/api/apps/subscriptions').expect(200)).body;
    expect(seen.received.map((x: { id: string }) => x.id)).toEqual([sub.id]);
    expect(seen.received[0]).not.toHaveProperty('destinations');
    expect((await mia.get(`/api/apps/subscriptions/${sub.id}/deliveries`).expect(200)).body.deliveries).toHaveLength(1);
    await mia.patch(`/api/apps/subscriptions/${sub.id}`, { name: 'Taken' }).expect(403);
    await mia.del(`/api/apps/subscriptions/${sub.id}`).expect(403);
    expect(await audits('app.delivery.sent')).toHaveLength(1);
  });

  it('delivers to a folder of the file store as the owner, who must be able to write there', async () => {
    const ada = await admin();
    const mia = await member('mia');
    const { viewId } = await setup(ada);
    const folder = (await ada.post('/api/files/folders', { workspaceId: wsId, name: 'Reports' }).expect(201)).body;
    const other = await h.s.tenants.createWorkspace(h.tenantId, 'Elsewhere', 'internal');
    const hidden = await h.s.db('file_folders').insert({ id: '01JAAAAAAAAAAAAAAAAAAAAAAA', tenant_id: h.tenantId, workspace_id: other.id, parent_id: null, name: 'Hidden', created_by: null, created_at: Date.now(), updated_at: Date.now() });
    expect(hidden).toBeTruthy();
    await mia.post('/api/apps/subscriptions', body(viewId, { destinations: { email: { self: false }, file: { folderId: '01JAAAAAAAAAAAAAAAAAAAAAAA' } } })).expect(404);
    const sub = (await ada.post('/api/apps/subscriptions', body(viewId, { destinations: { email: { self: false }, file: { folderId: folder.id } } })).expect(201)).body;
    expect(sub.destinations.file).toEqual({ folderId: folder.id });
    await runNow(ada, sub.id);
    const files = await h.s.db('files').where({ tenant_id: h.tenantId, folder_id: folder.id });
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ owner_id: ada.user.id, label: 'internal' });
    expect(String(files[0].name)).toMatch(/^deals \d{4}-\d{2}-\d{2} \d{4}\.csv$/);
    const d = await deliveries(sub.id);
    expect(d).toMatchObject([{ destination: 'file', outcome: 'sent', recipient_id: ada.user.id, file_id: files[0].id }]);
    expect(mail.sent.filter((m) => m.headers)).toHaveLength(0);
  });

  it('posts a signed webhook only to a host on the tenant list, with the integrations right, the secret sealed', async () => {
    hook = await new FakeReceiver().start();
    const ada = await admin();
    const mia = await member('mia');
    const { viewId } = await setup(ada);
    const dest = { email: { self: false }, webhook: { url: `${hook.url}/deliveries`, signing: 'hmac', maxLabel: 'internal' } };
    // No allowed hosts: nothing may receive deliveries.
    expect((await ada.post('/api/apps/subscriptions', body(viewId, { destinations: dest })).expect(403)).body.detail).toMatch(/no allowed hosts/);
    await h.s.integrations.set(h.tenantId, { allowedHosts: ['hooks.example.internal'] }, 'test');
    expect((await ada.post('/api/apps/subscriptions', body(viewId, { destinations: dest })).expect(403)).body.detail).toMatch(/not on this tenant's list/);
    await h.s.integrations.set(h.tenantId, { allowedHosts: ['127.0.0.1/32'] }, 'test');
    // A reader without webhooks:manage cannot add one.
    await mia.post('/api/apps/subscriptions', body(viewId, { destinations: dest })).expect(403);
    // Above the webhook's label: refused.
    await ada.post('/api/apps/subscriptions', body(viewId, { destinations: { ...dest, webhook: { ...dest.webhook, maxLabel: 'public' } } })).expect(400);
    const sub = (await ada.post('/api/apps/subscriptions', body(viewId, { destinations: dest })).expect(201)).body;
    expect(sub.webhookSecret).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(sub.destinations.webhook).toEqual({ host: new URL(hook.url).host, signing: 'hmac', maxLabel: 'internal' });
    const row = await h.s.db('app_subscriptions').where({ id: sub.id }).first();
    expect(String(row.webhook_secret)).not.toContain(sub.webhookSecret);
    expect((await ada.get(`/api/apps/subscriptions/${sub.id}`).expect(200)).body).not.toHaveProperty('webhookSecret');

    await runNow(ada, sub.id);
    expect(hook.got).toHaveLength(1);
    const got = hook.got[0]!;
    expect(got.path).toBe('/deliveries');
    expect(verifySignature(sub.webhookSecret, got.headers['x-exprsn-timestamp'] as string, got.headers['x-exprsn-signature'] as string, got.body)).toBe(true);
    const payload = JSON.parse(got.body);
    expect(payload).toMatchObject({ type: 'app.delivery', subscription: { id: sub.id, name: 'Morning deals' }, file: { filename: 'deals.csv', rows: 2 } });
    expect(Buffer.from(payload.content, 'base64').toString('utf8')).toContain(`rendered for ${ada.user.id}`);
    expect(await deliveries(sub.id)).toMatchObject([{ destination: 'webhook', outcome: 'sent' }]);

    // The host leaves the list: the next run sends nothing and records why.
    await h.s.integrations.set(h.tenantId, { allowedHosts: ['hooks.example.internal'] }, 'test');
    await runNow(ada, sub.id);
    expect(hook.got).toHaveLength(1);
    expect((await deliveries(sub.id))[1]).toMatchObject({ destination: 'webhook', outcome: 'failed', reason: expect.stringMatching(/not on this tenant's list/) });
  });

  it('sends only when there are rows, and only when the render changed', async () => {
    const ada = await admin();
    const { viewId } = await setup(ada);
    const sub = (await ada.post('/api/apps/subscriptions', body(viewId, { options: { onlyIfRows: true, onlyIfChanged: true } })).expect(201)).body;
    st.rows = 0;
    await runNow(ada, sub.id);
    expect(mail.sent.filter((m) => m.headers)).toHaveLength(0);
    st.rows = 3;
    await runNow(ada, sub.id);
    expect(dmail('ada@example.test')).toHaveLength(1);
    await runNow(ada, sub.id);
    expect(dmail('ada@example.test')).toHaveLength(1);
    st.version = 2;
    await runNow(ada, sub.id);
    expect(dmail('ada@example.test')).toHaveLength(2);
    expect((await deliveries(sub.id)).map((d) => d.outcome)).toEqual(['skipped-empty', 'sent', 'skipped-unchanged', 'sent']);
    expect(await audits('app.delivery.skipped')).toHaveLength(2);
    expect((await h.s.db('app_subscriptions').where({ id: sub.id }).first()).failures).toBe(0);
  });

  it('gives nothing to a recipient who cannot read the object, and re-checks access at every run', async () => {
    const ada = await admin();
    const mia = await member('mia');
    const noa = await member('noa', { member: false }); // not in the app's workspace
    const { viewId } = await setup(ada);
    const sub = (await ada.post('/api/apps/subscriptions', body(viewId, { destinations: { email: { self: true, others: ['mia', 'noa'] } } })).expect(201)).body;
    await runNow(ada, sub.id);
    expect(dmail('noa@example.test')).toHaveLength(0);
    expect(dmail('mia@example.test')).toHaveLength(1);
    expect(st.calls.map((c) => c.user)).not.toContain(noa.user.id);
    const d1 = await deliveries(sub.id);
    expect(d1.find((d) => d.recipient_id === noa.user.id)).toMatchObject({ outcome: 'denied', reason: 'They can no longer see the app.' });
    expect(await audits('app.delivery.denied')).toHaveLength(1);
    // A recipient's denial does not fail the subscription.
    expect((await h.s.db('app_subscriptions').where({ id: sub.id }).first()).failures).toBe(0);

    // Access revoked after the first delivery: mia leaves the workspace; the renderer also refuses a right it checks.
    await h.s.tenants.removeMember(wsId, mia.user.id);
    await runNow(ada, sub.id);
    expect(dmail('mia@example.test')).toHaveLength(1);
    expect(dmail('ada@example.test')).toHaveLength(2);
    st.deny.add(ada.user.id);
    await runNow(ada, sub.id);
    expect(dmail('ada@example.test')).toHaveLength(2);
    const last = (await deliveries(sub.id)).filter((d) => d.recipient_id === ada.user.id).pop()!;
    expect(last).toMatchObject({ outcome: 'denied', reason: expect.stringMatching(/connections:query/) });
    // The owner losing access is a failed run, recorded on the subscription.
    const row = await h.s.db('app_subscriptions').where({ id: sub.id }).first();
    expect(row).toMatchObject({ failures: 1, last_outcome: 'failed', last_problem: expect.stringMatching(/The owner gets nothing/) });

    // The view stops being shared: its readers (not its owner) are refused before any render.
    st.deny.clear();
    const mine = (await mia.get('/api/apps/subscriptions').expect(200)).body;
    expect(mine.received).toHaveLength(1);
  });

  it('links to a file-store copy when the file is larger than an attachment may be', async () => {
    const ada = await admin();
    const mia = await member('mia');
    const { viewId } = await setup(ada);
    const sub = (await ada.post('/api/apps/subscriptions', body(viewId, { destinations: { email: { self: false, others: ['mia'] } } })).expect(201)).body;
    st.big = true;
    await runNow(ada, sub.id);
    const m = dmail('mia@example.test');
    expect(m).toHaveLength(1);
    expect(m[0]!.attachments ?? []).toHaveLength(0);
    const fileLink = /#\/files\?file=([0-9A-Z]{26})/.exec(m[0]!.text);
    expect(fileLink).toBeTruthy();
    const f = await h.s.db('files').where({ id: fileLink![1] }).first();
    expect(f).toMatchObject({ owner_id: mia.user.id, workspace_id: wsId });
    const folder = await h.s.db('file_folders').where({ id: f.folder_id }).first();
    expect(folder.name).toBe('Deliveries');
    expect((await deliveries(sub.id))[0]).toMatchObject({ destination: 'email', outcome: 'linked', file_id: f.id });
    expect(m[0]!.text).toMatch(/more than the 2 kB that can be attached/);
    // The copy is mia's: she can open it, ada (the subscriber) gets no handle on it through the email.
    await mia.get(`/api/files/${f.id}`).expect(200);
  });

  it('retries a failed run with backoff, pauses after repeated failures and tells the owner', async () => {
    const ada = await admin();
    const { viewId } = await setup(ada);
    const sub = (await ada.post('/api/apps/subscriptions', body(viewId)).expect(201)).body;
    st.fail = 'database unavailable';
    await runNow(ada, sub.id);
    // First attempt failed; the job waits for its retry.
    const job = await h.s.db('jobs').where({ type: 'apps.subscription.deliver' }).orderBy('created_at', 'desc').first();
    expect(job).toMatchObject({ state: 'queued', attempts: 1 });
    expect(Number(job.run_at)).toBeGreaterThan(Date.now());
    expect((await h.s.db('app_subscription_runs').where({ subscription_id: sub.id }).first()).state).toBe('retrying');
    await retryNow();
    expect((await h.s.db('jobs').where({ id: job.id }).first()).state).toBe('failed');
    let row = await h.s.db('app_subscriptions').where({ id: sub.id }).first();
    expect(row).toMatchObject({ state: 'active', failures: 1, last_outcome: 'failed' });
    expect(st.calls).toHaveLength(2);
    // A second failed run in a row pauses it (APPS_DELIVERY_PAUSE_AFTER 2) and notifies the owner.
    await runNow(ada, sub.id);
    await retryNow();
    row = await h.s.db('app_subscriptions').where({ id: sub.id }).first();
    expect(row).toMatchObject({ state: 'paused', failures: 2, next_run_at: null, paused_reason: expect.stringMatching(/Paused after 2 failed runs/) });
    const note = await h.s.db('notifications').where({ user_id: ada.user.id, kind: 'app.subscription.paused' }).first();
    expect(note.title).toBe('Delivery paused: Morning deals');
    expect(await audits('app.subscription.paused')).toHaveLength(1);
    expect(await audits('app.delivery.failed')).toHaveLength(2);
    expect(await h.s.apps.subscriptions.tick(Date.now() + 10 * 86_400_000)).toEqual({ queued: 0, paused: 0 });
    await ada.post(`/api/apps/subscriptions/${sub.id}/run`).expect(409);
    // Resuming re-checks access and clears the count.
    st.fail = null;
    const resumed = (await ada.patch(`/api/apps/subscriptions/${sub.id}`, { state: 'active' }).expect(200)).body;
    expect(resumed).toMatchObject({ state: 'active', failures: 0, pausedReason: null });
    expect(resumed.nextRunAt).toBeGreaterThan(Date.now());
    await runNow(ada, sub.id);
    expect(dmail('ada@example.test')).toHaveLength(1);
  });

  it('unsubscribes one recipient through the signed link, which a GET never changes', async () => {
    const ada = await admin();
    const mia = await member('mia');
    const { viewId } = await setup(ada);
    const sub = (await ada.post('/api/apps/subscriptions', body(viewId, { destinations: { email: { self: true, others: ['mia'] } } })).expect(201)).body;
    await runNow(ada, sub.id);
    const link = /(http:\/\/localhost:8080)(\/api\/public\/app-subscriptions\/unsubscribe\?t=([^\s]+))/.exec(dmail('mia@example.test')[0]!.text)!;
    const path = link[2]!;
    const token = decodeURIComponent(link[3]!);
    const anon = request(h.app);
    const page = await anon.get(path).expect(200);
    expect(page.text).toContain('Stop your email copies of Morning deals');
    expect(page.headers['cache-control']).toMatch(/no-store/);
    expect((await h.s.db('app_subscription_recipients').where({ subscription_id: sub.id, user_id: mia.user.id }).first()).unsubscribed_at).toBeNull();
    // An altered link changes nothing.
    const forged = token.replace(/.$/, (c) => (c === '0' ? '1' : '0'));
    await anon.post('/api/public/app-subscriptions/unsubscribe').type('form').send({ t: forged }).expect(404);
    const otherUser = token.replace(mia.user.id, ada.user.id);
    await anon.post('/api/public/app-subscriptions/unsubscribe').type('form').send({ t: otherUser }).expect(404);
    // The one-click form (RFC 8058) unsubscribes mia only.
    await anon.post(path).type('form').send('List-Unsubscribe=One-Click').expect(200);
    expect((await anon.get(path).expect(200)).text).toContain('Already unsubscribed');
    const u = (await audits('app.subscription.unsubscribed'))[0]!;
    expect(JSON.parse(u.detail!)).toMatchObject({ via: 'link', user: mia.user.id });
    await runNow(ada, sub.id);
    expect(dmail('mia@example.test')).toHaveLength(1);
    expect(dmail('ada@example.test')).toHaveLength(2);
    const view = (await ada.get(`/api/apps/subscriptions/${sub.id}`).expect(200)).body;
    expect(view.destinations.email.others).toMatchObject([{ username: 'mia', unsubscribed: true }]);
    // The signed-in owner can stop their own copies from the console too.
    await ada.post(`/api/apps/subscriptions/${sub.id}/unsubscribe`).expect(200);
    await runNow(ada, sub.id);
    expect(dmail('ada@example.test')).toHaveLength(2);
  });

  it('lists every subscription to a tenant admin, who may pause or delete but not change one, and audits it all', async () => {
    const ada = await admin();
    const mia = await member('mia');
    const { viewId } = await setup(ada);
    const sub = (await mia.post('/api/apps/subscriptions', body(viewId, { name: 'Mia daily' })).expect(201)).body;
    await mia.get('/api/apps/subscriptions/all').expect(403);
    const all = (await ada.get('/api/apps/subscriptions/all').expect(200)).body.subscriptions;
    expect(all).toMatchObject([{ id: sub.id, name: 'Mia daily', owner: { username: 'mia' }, mine: false }]);
    await ada.patch(`/api/apps/subscriptions/${sub.id}`, { name: 'Renamed' }).expect(403);
    await ada.patch(`/api/apps/subscriptions/${sub.id}`, { state: 'active' }).expect(403);
    const paused = (await ada.patch(`/api/apps/subscriptions/${sub.id}`, { state: 'paused' }).expect(200)).body;
    expect(paused).toMatchObject({ state: 'paused', pausedReason: 'Paused by a tenant admin.' });
    await mia.patch(`/api/apps/subscriptions/${sub.id}`, { state: 'active', schedule: { preset: 'weekdays', values: { hour: 7 }, timezone: 'Europe/London' } }).expect(200);
    await mia.patch(`/api/apps/subscriptions/${sub.id}`, { name: 'Mia weekdays', format: 'xlsx', options: { onlyIfRows: true } }).expect(200);
    const got = (await mia.get(`/api/apps/subscriptions/${sub.id}`).expect(200)).body;
    expect(got).toMatchObject({ name: 'Mia weekdays', format: 'xlsx', options: { onlyIfRows: true }, schedule: { cron: '0 7 * * 1-5', timezone: 'Europe/London' } });
    await ada.del(`/api/apps/subscriptions/${sub.id}`).expect(204);
    await mia.get(`/api/apps/subscriptions/${sub.id}`).expect(404);
    for (const a of ['app.subscription.created', 'app.subscription.paused', 'app.subscription.resumed', 'app.subscription.updated', 'app.subscription.deleted']) expect(await audits(a), a).not.toHaveLength(0);
    const del = (await audits('app.subscription.deleted'))[0]!;
    expect(JSON.parse(del.detail!)).toEqual({ owner: mia.user.id });
    // Validation: one destination at least, a known kind and format, the tenant from the session.
    await mia.post('/api/apps/subscriptions', body(viewId, { destinations: { email: { self: false } } })).expect(400);
    await mia.post('/api/apps/subscriptions', body(viewId, { format: 'docx' })).expect(400);
    await mia.post('/api/apps/subscriptions', { ...body(viewId), tenantId: 'x' }).expect(400);
  });

  it('delivers a view rendered by the real exporter (B-123), as the subscriber, when this build has it', async (ctx) => {
    if (!original || typeof original.render !== 'function') {
      ctx.skip();
      return;
    }
    (h.s as unknown as { appExports: AppExportsLike }).appExports = original;
    const ada = await admin();
    await member('mia');
    const { viewId } = await setup(ada);
    for (const [title, amount] of [['Acme renewal', 120], ['Globex pilot', 80], ['Initech upsell', 45]] as const) await ada.post('/api/apps/crm/entities/deal/records', { values: { title, amount } }).expect(201);
    const sub = (await ada.post('/api/apps/subscriptions', body(viewId, { destinations: { email: { self: true, others: ['mia'] } } })).expect(201)).body;
    await runNow(ada, sub.id);
    const csv = attachmentOf(dmail('ada@example.test')[0]!);
    expect(csv).toContain('Acme renewal');
    expect(csv).toContain('Initech upsell');
    expect(dmail('ada@example.test')[0]!.attachments![0]!.contentType).toMatch(/text\/csv/);
    expect(dmail('mia@example.test')).toHaveLength(1);
    const d = await deliveries(sub.id);
    expect(d.map((x) => [x.outcome, x.row_count])).toEqual([['sent', 3], ['sent', 3]]);
  });

  it('refuses a report or dashboard with a clear problem when the renderer is not available', async () => {
    const ada = await admin();
    await setup(ada);
    delete (h.s as unknown as { appExports?: unknown }).appExports;
    const res = await ada.post('/api/apps/subscriptions', { name: 'Board', app: 'crm', kind: 'dashboard', id: '01JBBBBBBBBBBBBBBBBBBBBBBB', format: 'pdf', schedule: { preset: 'monday-morning', timezone: 'UTC' }, destinations: { email: { self: true } } }).expect(503);
    expect(res.body).toMatchObject({ title: 'Not available', detail: expect.stringMatching(/s\.appExports\.render/) });
    expect((await ada.get('/api/apps/subscriptions/options').expect(200)).body.renderAvailable).toBe(false);
  });
});
