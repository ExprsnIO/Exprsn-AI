import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bearerOf, convertValue, mapCondition, mapStates, platformBase, type PApp, type PEntity, type PFlow, type PForm, type PLookup, type PRecord } from '../src/apps/platform-import.js';
import { harness, localUser, login, loginAdmin, type Harness } from './helpers.js';
import { drain } from './retrieval-seed.js';

/*
 * Importing the exprsn-platform's low-code apps into Apps (apps/platform-import.ts). The fake below answers the
 * platform lowcode module's routes the importer uses (routes/design.js and routes/records.js), with payloads shaped
 * as its Sequelize models serialise them, and records every write so the tests can check that only the link lookup
 * is ever written and nothing is deleted.
 */

const TOKEN = 'platform-bearer-cortex-0123456789';

interface FakeApp {
  app: PApp;
  entities: PEntity[];
  lookups: PLookup[];
  forms: PForm[];
  flows: (PFlow & { trigger: { type: string; cron?: string; secret?: string } | null })[];
  records: Map<string, PRecord[]>;
  /** 1.8.0 (B-143): the exprsn-svr security API's AppRoles of the app. */
  roles?: { name: string; displayName?: string; description?: string | null; permissions?: Record<string, unknown> }[];
}

class FakePlatform {
  server!: Server;
  url = '';
  apps: FakeApp[] = [];
  writes: { method: string; path: string; body: unknown }[] = [];
  refused: string[] = [];

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', () => r()));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()));
  }
  private send(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }
  private async handle(req: IncomingMessage, res: ServerResponse) {
    const u = new URL(req.url ?? '/', this.url);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
    if (u.pathname === '/lowcode/health') return this.send(res, 200, { status: 'ok', module: 'lowcode', enabled: true });
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return this.send(res, 401, { error: 'UNAUTHENTICATED', message: 'Valid bearer required' });
    const appId = u.searchParams.get('appId');
    const a = this.apps.find((x) => x.app.id === appId);
    const p = u.pathname;
    if (req.method === 'GET') {
      if (p === '/lowcode/api/design/apps') return this.send(res, 200, { apps: this.apps.map((x) => ({ ...x.app, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' })) });
      const m = /^\/lowcode\/api\/design\/apps\/([^/]+)$/.exec(p);
      if (m) {
        const one = this.apps.find((x) => x.app.id === m[1]);
        return one ? this.send(res, 200, { app: one.app }) : this.send(res, 404, { error: 'NOT_FOUND' });
      }
      if (p === '/lowcode/api/security/roles') {
        const ra = this.apps.find((x) => x.app.id === u.searchParams.get('applicationId'));
        return this.send(res, 200, { success: true, data: { roles: ra?.roles ?? [], total: ra?.roles?.length ?? 0 } });
      }
      if (!a && /^\/lowcode\/api\/(design|data)\//.test(p)) return this.send(res, 403, { error: 'FORBIDDEN', message: 'appId required' });
      if (p === '/lowcode/api/design/entities') return this.send(res, 200, { entities: a!.entities.map((e) => ({ ...e, appId: a!.app.id, app_id: a!.app.id })) });
      if (p === '/lowcode/api/design/lookups') return this.send(res, 200, { lookups: a!.lookups.map((l) => ({ ...l, appId: a!.app.id })) });
      if (p === '/lowcode/api/design/forms') return this.send(res, 200, { forms: a!.forms.map((f) => ({ ...f, appId: a!.app.id, slug: f.isPublic ? 'a1b2c3d4e5f6a7b8c9' : null })) });
      if (p === '/lowcode/api/design/flows') return this.send(res, 200, { flows: a!.flows.map((f) => ({ ...f, appId: a!.app.id, scopeType: 'platform' })) });
      const r = /^\/lowcode\/api\/data\/([^/]+)\/records$/.exec(p);
      if (r) {
        const e = a!.entities.find((x) => x.key === r[1]);
        if (!e) return this.send(res, 404, { error: 'NOT_FOUND', message: 'entity not found' });
        const all = a!.records.get(e.key) ?? [];
        const limit = Math.min(Number(u.searchParams.get('limit')) || 100, 500);
        const offset = Number(u.searchParams.get('offset')) || 0;
        const rows = all.slice(offset, offset + limit).map((x) => ({ ...x, entityId: e.id, appId: a!.app.id, ownerId: randomUUID(), scopeType: 'platform', scopeId: null, storageRef: null, createdAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z', entity_id: e.id }));
        return this.send(res, 200, { records: rows, total: all.length, limit, offset });
      }
    }
    if (req.method === 'POST' && p === '/lowcode/api/design/lookups') {
      this.writes.push({ method: 'POST', path: p, body });
      const owner = this.apps.find((x) => x.app.id === body.appId)!;
      const lookup = { id: randomUUID(), key: body.key, name: body.name, values: body.values, source: null };
      owner.lookups.push(lookup);
      return this.send(res, 201, { lookup });
    }
    const put = /^\/lowcode\/api\/design\/lookups\/([^/]+)$/.exec(p);
    if (req.method === 'PUT' && put) {
      this.writes.push({ method: 'PUT', path: p, body });
      for (const x of this.apps) {
        const l = x.lookups.find((y) => y.id === put[1]);
        if (l) {
          l.values = body.values;
          return this.send(res, 200, { lookup: l });
        }
      }
      return this.send(res, 404, { error: 'NOT_FOUND' });
    }
    this.refused.push(`${req.method} ${p}`);
    return this.send(res, 404, { error: 'NOT_FOUND', message: 'Endpoint not found' });
  }
}

// ---------- the platform app: the cortex app of scripts/exprsn-platform/ai/cortex-spark-platform.mjs, plus a kitchen sink ----------

const text = (key: string, label: string, o: Record<string, unknown> = {}) => ({ key, label, type: 'string', ...o });
const long = (key: string, label: string, o: Record<string, unknown> = {}) => ({ key, label, type: 'text', ...o });
const pick = (key: string, label: string, values: string[]) => ({ key, label, type: 'enum', enumValues: values, role: 'dimension' });
const machine = (initial: string, states: string[], transitions: [string | string[], string][]) => ({ initial, states, transitions: transitions.flatMap(([from, to]) => (Array.isArray(from) ? from : [from]).map((f) => ({ from: f, event: to, to }))) });

function cortexApp(): FakeApp {
  const appId = randomUUID();
  const ids = { requests: randomUUID(), tasks: randomUUID(), feedback: randomUUID(), kitchen: randomUUID() };
  const people = randomUUID();
  const entities: PEntity[] = [
    {
      id: ids.requests,
      key: 'requests',
      name: 'Requests',
      description: 'What the assistant was asked.',
      fields: [text('subject', 'Subject', { required: true }), long('body', 'What was asked'), text('asked_by', 'Asked by'), pick('kind', 'Kind', ['question', 'request', 'incident']), pick('urgency', 'Urgency', ['low', 'normal', 'high']), { key: 'needs_person', label: 'Needs a person', type: 'boolean' }, { key: 'asked_at', label: 'Asked at', type: 'datetime' }] as never,
      stateMachine: machine('new', ['new', 'in_progress', 'answered', 'escalated', 'closed'], [['new', 'in_progress'], [['new', 'in_progress'], 'answered'], [['new', 'in_progress', 'answered'], 'escalated'], [['answered', 'escalated'], 'closed'], ['closed', 'in_progress']]),
      storage: null
    },
    {
      id: ids.tasks,
      key: 'tasks',
      name: 'Tasks',
      description: null,
      fields: [text('title', 'Title', { required: true }), long('detail', 'Detail'), { key: 'request', label: 'Request', type: 'reference', refEntity: 'requests' }, text('owner', 'Owner'), { key: 'due', label: 'Due', type: 'date' }, pick('priority', 'Priority', ['low', 'normal', 'high'])] as never,
      stateMachine: machine('open', ['open', 'doing', 'done', 'cancelled'], [['open', 'doing'], [['open', 'doing'], 'done'], [['open', 'doing'], 'cancelled'], [['done', 'cancelled'], 'open']]),
      storage: null
    },
    {
      id: ids.feedback,
      key: 'feedback',
      name: 'Feedback',
      description: null,
      fields: [{ key: 'request', label: 'Request', type: 'reference', refEntity: 'requests' }, { key: 'rating', label: 'Rating (1 to 5)', type: 'integer', required: true, role: 'measure', aggregation: 'avg', min: 1, max: 5 }, long('comment', 'Comment')] as never,
      stateMachine: null,
      storage: null
    },
    {
      id: ids.kitchen,
      key: 'kitchen',
      name: 'Every type',
      description: null,
      fields: [
        text('code', 'Code', { required: true, unique: true, max: 40 }),
        { key: 'amount', label: 'Amount', type: 'number', min: 0, role: 'measure' },
        { key: 'count', label: 'Count', type: 'integer', default: 1 },
        { key: 'flag', label: 'Flag', type: 'boolean' },
        { key: 'day', label: 'Day', type: 'date' },
        { key: 'at', label: 'At', type: 'datetime' },
        { key: 'colour', label: 'Colour', type: 'enum', enumLookup: 'colours' },
        { key: 'pick_request', label: 'Pick a request', type: 'enum', enumLookup: 'request_list' },
        { key: 'person', label: 'Person', type: 'enum', enumLookup: 'people' },
        { key: 'meta', label: 'Meta', type: 'json' },
        { key: 'doc', label: 'Document', type: 'file' },
        { key: 'double', label: 'Double', type: 'number', formula: 'amount * 2' },
        { key: 'odd', label: 'Odd formula', type: 'string', formula: 'CONCAT_WEIRD(code)' },
        { key: 'summary', label: 'Summary', type: 'text', aiPrompt: 'Summarise {{code}}' },
        { key: 'state', label: 'Platform state', type: 'string' },
        { key: 'dueDate', label: 'Due date', type: 'date' }
      ] as never,
      stateMachine: { initial: 'Draft', states: ['Draft', 'Live'], transitions: [{ from: 'Draft', event: 'go live', to: 'Live', guard: { field: 'record.data.flag', op: 'equals', value: true } }] },
      storage: { mode: 'mirror' }
    }
  ];
  const lookups: PLookup[] = [
    { id: randomUUID(), key: 'colours', name: 'Colours', values: [{ value: 'red', label: 'Red' }, { value: 'green', label: 'Green' }, { value: 'Red' }], source: { type: 'static' } },
    { id: randomUUID(), key: 'request_list', name: 'Requests', values: [], source: { type: 'provider', provider: 'lowcode.entity', params: { entityKey: 'requests', labelField: 'subject' } } },
    { id: people, key: 'people', name: 'People', values: [], source: { type: 'provider', provider: 'platform.users', params: {} } },
    { id: randomUUID(), key: 'unused', name: 'Unused', values: [{ value: 'x' }], source: null }
  ];
  const r1 = randomUUID();
  const r2 = randomUUID();
  const r3 = randomUUID();
  const t1 = randomUUID();
  const records = new Map<string, PRecord[]>([
    ['requests', [
      { id: r1, data: { subject: 'Reset my password', body: 'Line one\nLine two', asked_by: 'mia', kind: 'question', urgency: 'normal', needs_person: false, asked_at: '2026-10-01T09:00:00.000Z' }, state: 'answered' },
      { id: r2, data: { subject: 'The feed is down', kind: 'incident', urgency: 'high', needs_person: true, asked_at: 'Thu, 01 Oct 2026 10:00:00 GMT' }, state: 'escalated' },
      { id: r3, data: { subject: 'Closed one', kind: 'request', urgency: 'low' }, state: 'closed' }
    ]],
    ['tasks', [
      { id: t1, data: { title: 'Answer the feed incident', request: r2, owner: 'dee', due: '2026-10-20', priority: 'high' }, state: 'doing' },
      { id: randomUUID(), data: { title: 'Orphan task', request: randomUUID(), priority: 'low' }, state: 'open' }
    ]],
    ['feedback', [{ id: randomUUID(), data: { request: r1, rating: 5, comment: 'Quick' } }]],
    ['kitchen', [
      { id: randomUUID(), data: { code: 'ABC', amount: 2.5, count: 3, flag: true, day: '2026-10-03', at: '2026-10-03T08:30:00Z', colour: 'red', pick_request: r1, person: randomUUID(), meta: { a: 1 }, doc: { fileId: randomUUID(), name: 'a.pdf' }, double: 5, odd: 'x', summary: 'An AI summary', state: 'kept', dueDate: '2026-11-01' }, state: 'Live' },
      { id: randomUUID(), data: { code: 'abc', amount: 1 }, state: 'Draft' }
    ]]
  ]);
  const forms: PForm[] = [
    { id: randomUUID(), key: 'ask', name: 'Ask', entityKey: 'requests', layout: { sections: [{ title: 'Your request', fields: ['subject', { key: 'body', help: 'What you have tried.' }, 'kind', { key: 'urgency', visibleWhen: { field: 'kind', op: 'equals', value: 'incident' } }] }], submitLabel: 'Send to Cortex' }, isPublic: true, settings: { successMessage: 'Thanks' } },
    { id: randomUUID(), key: 'new_task', name: 'New task', entityKey: 'tasks', layout: { sections: [{ title: 'Task', fields: ['title', { key: 'detail', visibleWhen: { field: 'title', op: 'length_gt', value: 3 } }, 'request'] }, { title: 'Who and when', fields: ['owner', 'due', { key: 'priority', placeholder: 'normal', visibleWhen: { any: [{ field: 'owner', op: 'exists' }] } }] }], steps: true }, isPublic: false, settings: {} },
    { id: randomUUID(), key: 'computed_only', name: 'Computed only', entityKey: 'kitchen', layout: { sections: [{ fields: ['double'] }] }, isPublic: false, settings: {} }
  ];
  const flows: FakeApp['flows'] = [
    { id: randomUUID(), key: 'request-needs-person', name: 'A request that needs a person opens a task', event: 'lowcode.record.created', trigger: { type: 'event' }, match: { all: [{ op: 'equals', field: 'app', value: appId }, { op: 'equals', field: 'entity', value: 'requests' }, { op: 'equals', field: 'record.data.needs_person', value: true }] }, actions: [{ type: 'create_record', entity: 'tasks', data: { title: 'A request to Cortex needs a person', priority: 'high' }, onError: 'continue' }], enabled: true },
    { id: randomUUID(), key: 'escalate-high', name: 'High urgency is escalated', event: 'lowcode.record.updated', trigger: { type: 'event' }, match: { all: [{ op: 'equals', field: 'entity', value: 'requests' }], any: [{ op: 'equals', field: 'record.data.urgency', value: 'high' }, { op: 'in', field: 'record.data.kind', value: ['incident'] }] }, actions: [{ type: 'log', message: 'escalating' }, { type: 'transition_record', event: 'escalated', retries: 2 }, { type: 'update_record', data: { needs_person: true }, when: { field: 'record.state', op: 'not_equals', value: 'closed' } }], enabled: true },
    { id: randomUUID(), key: 'nightly', name: 'Nightly', event: '_schedule', trigger: { type: 'schedule', cron: '0 2 * * *' }, match: null, actions: [{ type: 'create_record', entityKey: 'tasks', data: { title: 'Nightly review' } }], enabled: false },
    { id: randomUUID(), key: 'hook-in', name: 'From a webhook', event: '_webhook', trigger: { type: 'webhook', secret: 'f'.repeat(48) }, match: null, actions: [{ type: 'create_record', entityKey: 'tasks', data: { title: 'x' } }], enabled: true },
    { id: randomUUID(), key: 'tell-owner', name: 'Tell the owner', event: 'lowcode.record.created', trigger: { type: 'event' }, match: { field: 'entity', op: 'equals', value: 'tasks' }, actions: [{ type: 'notify', title: 'New task' }], enabled: true },
    { id: randomUUID(), key: 'regex', name: 'Regex', event: 'lowcode.record.created', trigger: { type: 'event' }, match: { all: [{ field: 'entity', op: 'equals', value: 'requests' }, { field: 'record.data.subject', op: 'matches', value: '^x' }] }, actions: [{ type: 'create_record', entityKey: 'tasks', data: { title: 'x' } }], enabled: true },
    { id: randomUUID(), key: 'call-out', name: 'Call out', event: 'lowcode.record.created', trigger: { type: 'event' }, match: { field: 'entity', op: 'equals', value: 'tasks' }, actions: [{ type: 'http_request', method: 'POST', url: 'https://hooks.example.com/x', headers: { Authorization: 'Bearer do-not-copy-0000' }, body: { a: 1 } }], enabled: true },
    { id: randomUUID(), key: 'timeline', name: 'Post to the timeline', event: 'timeline.post.created', trigger: null, match: null, actions: [{ type: 'post_timeline', text: 'hi' }], enabled: true }
  ];
  return { app: { id: appId, key: 'cortex', name: 'Cortex', description: 'The working records of Cortex.', status: 'published', scopeType: 'user', scopeId: randomUUID(), capabilities: [] }, entities, lookups, forms, flows, records };
}

describe('mapping helpers', () => {
  it('maps conditions, states, values, bearers and base URLs', () => {
    const problems: string[] = [];
    expect(mapCondition({ all: [{ field: 'record.data.a', op: 'equals', value: 1 }], none: [{ field: 'record.data.b', op: 'exists' }] }, (x) => x.replace('record.data.', ''), problems)).toEqual({ all: [{ all: [{ field: 'a', op: 'eq', value: 1 }] }, { none: [{ field: 'b', op: 'exists' }] }] });
    expect(mapCondition({ field: 'a', op: 'keywords_any', value: ['x'] }, (x) => x, problems)).toBeNull();
    expect(problems.join()).toMatch(/keywords_any/);
    const sm = mapStates({ initial: 'Draft', states: ['Draft', 'In Review', 'done'], transitions: [{ from: 'Draft', event: 'submit', to: 'In Review' }, { from: '*', event: 'finish', to: 'done' }, { from: 'In Review', event: 'finish', to: 'done' }] });
    expect(sm.states).toEqual({ initial: 'draft', states: [{ name: 'draft' }, { name: 'in_review' }, { name: 'done' }], transitions: [{ name: 'submit', from: ['draft'], to: 'in_review' }, { name: 'finish', from: ['*'], to: 'done' }] });
    expect(convertValue({ name: 'd', type: 'date', withTime: false, required: false, indexed: false, unique: false }, '2026-10-01T23:00:00Z')).toBe('2026-10-01');
    expect(convertValue({ name: 'd', type: 'date', withTime: true, required: false, indexed: false, unique: false }, 'Thu, 01 Oct 2026 10:00:00 GMT')).toBe('2026-10-01T10:00:00.000Z');
    expect(bearerOf('{"token":"abc","user":{"id":"x"}}')).toBe('abc');
    expect(bearerOf(' plain ')).toBe('plain');
    expect(platformBase('https://localhost:8443/')).toBe('https://127.0.0.1:8443');
    expect(() => platformBase('http://example.com')).toThrow(/https/);
  });
});

describe('importing platform apps', () => {
  let h: Harness;
  let fake: FakePlatform;
  let wsId: string;

  beforeEach(async () => {
    fake = new FakePlatform();
    await fake.start();
    fake.apps.push(cortexApp());
    h = await harness({ PLATFORM_LOWCODE_URL: fake.url, PLATFORM_LOWCODE_TOKEN: TOKEN });
    wsId = (await h.s.tenants.createWorkspace(h.tenantId, 'Ops', 'confidential')).id;
  });
  afterEach(async () => {
    await h.close();
    await fake.stop();
  });

  async function as(name: string, roles: string[], clearance: 'internal' | 'confidential' | 'restricted' = 'confidential') {
    const u = await localUser(h, name, roles, clearance);
    await h.s.tenants.addMember(wsId, u.id);
    const c = roles.some((r) => ['system-admin', 'tenant-admin', 'workflow-admin'].includes(r)) ? await loginAdmin(h, name) : await login(h, name);
    const send = (method: 'post' | 'put', path: string, body: object = {}) => c.agent[method](path).set('x-csrf-token', c.csrf).send(body);
    await send('put', '/api/me/workspace', { workspaceId: wsId }).expect(200);
    return { user: u, post: (p: string, b?: object) => send('post', p, b), get: (p: string) => c.agent.get(p) };
  }
  const audits = async (action: string) => (await h.s.db('audit_events').where({ tenant_id: h.tenantId, action })) as { target: string; detail: string | null }[];
  const target = { mode: 'new', name: 'cortex_platform', title: 'Cortex (platform)', label: 'internal' };
  type Admin = Awaited<ReturnType<typeof as>>;
  const importRun = async (a: Admin, body: object = {}) => {
    const plan = (await a.post('/api/apps/platform-import/plan', { platformApp: 'cortex', target, ...body }).expect(200)).body;
    const started = (await a.post('/api/apps/platform-import/runs', { planId: plan.id }).expect(202)).body;
    await drain(h);
    const run = (await a.get(`/api/apps/platform-import/runs/${started.id}`).expect(200)).body;
    return { plan, run };
  };

  it('needs apps:design and platform:manage, and the label within clearance', async () => {
    const designer = await as('dee', ['workflow-admin', 'member']);
    await designer.get('/api/apps/platform-import/apps').expect(403);
    await designer.post('/api/apps/platform-import/plan', { platformApp: 'cortex', target }).expect(403);
    const tenantAdmin = await as('tia', ['tenant-admin']);
    await tenantAdmin.get('/api/apps/platform-import/apps').expect(403);
    const low = await as('lou', ['system-admin'], 'internal');
    const r = await low.post('/api/apps/platform-import/plan', { platformApp: 'cortex', target: { ...target, label: 'confidential' } }).expect(403);
    expect(r.body.detail).toMatch(/clearance is internal/);
    // another person's dry run cannot be started
    const ops = await as('ops', ['system-admin']);
    const plan = (await ops.post('/api/apps/platform-import/plan', { platformApp: 'cortex', target }).expect(200)).body;
    await low.post('/api/apps/platform-import/runs', { planId: plan.id }).expect(404);
    // a wrong platform token is a clear problem, never the token
    await h.close();
    h = await harness({ PLATFORM_LOWCODE_URL: fake.url, PLATFORM_LOWCODE_TOKEN: 'wrong-token-0000' });
    wsId = (await h.s.tenants.createWorkspace(h.tenantId, 'Ops', 'confidential')).id;
    const again = await as('ops2', ['system-admin']);
    const bad = await again.get('/api/apps/platform-import/apps').expect(502);
    expect(bad.body.detail).toMatch(/401/);
    expect(JSON.stringify(bad.body)).not.toContain('wrong-token');
  });

  it('lists platform apps and reports the whole mapping in a dry run', async () => {
    const a = await as('ops', ['system-admin']);
    const list = (await a.get('/api/apps/platform-import/apps').expect(200)).body;
    expect(list.apps).toEqual([expect.objectContaining({ key: 'cortex', name: 'Cortex', imported: null, markedOnPlatform: [] })]);
    const { id, report } = (await a.post('/api/apps/platform-import/plan', { platformApp: 'cortex', target }).expect(200)).body;
    expect(id).toHaveLength(26);
    expect(report.target).toMatchObject({ mode: 'new', name: 'cortex_platform', label: 'internal', workspaceId: wsId });
    const kitchen = report.entities.find((e: { source: string }) => e.source === 'kitchen');
    const to = Object.fromEntries(kitchen.fields.map((f: { source: string; to: string; name: string }) => [f.source, `${f.name}:${f.to}`]));
    expect(to).toEqual({
      code: 'code:string', amount: 'amount:number', count: 'count:number', flag: 'flag:boolean', day: 'day:date', at: 'at:date',
      colour: 'colour:lookup', pick_request: 'pick_request:lookup', person: 'person:string', meta: 'meta:json', doc: 'doc:json',
      double: 'double:formula', odd: 'odd:string', summary: 'summary:string (multi-line)', state: 'state_value:string', dueDate: 'duedate:date'
    });
    const notes = JSON.stringify(kitchen);
    expect(notes).toMatch(/entity lookup of requests/);
    expect(notes).toMatch(/platform\.users/);
    expect(notes).toMatch(/FileVault/);
    expect(notes).toMatch(/default 1/);
    expect(notes).toMatch(/guard/);
    expect(notes).toMatch(/storage mode mirror/);
    expect(notes).toMatch(/option Red listed twice/);
    expect(kitchen.states).toMatchObject({ initial: 'draft', states: ['draft', 'live'], renamed: { Draft: 'draft', Live: 'live' } });
    const requests = report.entities.find((e: { source: string }) => e.source === 'requests');
    expect(requests.fields.find((f: { source: string }) => f.source === 'body').to).toBe('string (multi-line)');
    // new→in_progress and closed→in_progress share the event and target: one transition from both
    expect(requests.states.transitions).toBe(4);
    // records: the orphan task's reference and the case-insensitive duplicate code fail validation
    expect(report.records).toMatchObject({ total: 8, create: 6, invalid: 2 });
    expect(report.records.problems.map((x: { problems: string[] }) => x.problems.join()).join('\n')).toMatch(/not imported[\s\S]*unique/);
    // forms: flattened, help and one condition kept; public link and steps dropped; a computed-only form is skipped
    const ask = report.forms.find((f: { sourceKey: string }) => f.sourceKey === 'ask');
    expect(ask).toMatchObject({ action: 'create', fields: 4 });
    expect(JSON.stringify(ask.dropped)).toMatch(/public link/);
    const newTask = report.forms.find((f: { sourceKey: string }) => f.sourceKey === 'new_task');
    expect(newTask.notes.join()).toMatch(/2 wizard steps/);
    expect(JSON.stringify(newTask.dropped)).toMatch(/detail: visible when[\s\S]*length_gt[\s\S]*placeholder/);
    expect(JSON.stringify(newTask.dropped)).not.toMatch(/priority: visible when/);
    expect(report.forms.find((f: { sourceKey: string }) => f.sourceKey === 'computed_only')).toMatchObject({ action: 'skip', reason: expect.stringMatching(/none of its fields/) });
    // flows: mapped and not, each with the reason
    const flows = Object.fromEntries(report.flows.map((f: { sourceKey: string; imported: boolean; reasons: string[] }) => [f.sourceKey, f]));
    expect(flows['request-needs-person']).toMatchObject({ imported: true, trigger: { kind: 'record', events: ['created'] }, actions: ['create'], enabled: false });
    expect(JSON.stringify(flows['request-needs-person'].notes)).toMatch(/entityKey/);
    expect(flows['escalate-high']).toMatchObject({ imported: true, trigger: { kind: 'record', events: ['updated'] }, actions: ['transition', 'update'] });
    expect(JSON.stringify(flows['escalate-high'].notes)).toMatch(/log marker/);
    expect(flows.nightly).toMatchObject({ imported: true, trigger: { kind: 'schedule', cron: '0 2 * * *' } });
    expect(flows['hook-in']).toMatchObject({ imported: true, trigger: { kind: 'webhook' }, actions: ['create'] });
    expect(flows['hook-in'].notes.join()).toMatch(/without a secret/);
    expect(flows['call-out'].reasons.join()).toMatch(/header Authorization carries a credential/);
    expect(JSON.stringify(report)).not.toContain('do-not-copy');
    expect(flows['tell-owner'].reasons.join()).toMatch(/owner/);
    expect(flows.regex.reasons.join()).toMatch(/matches/);
    expect(flows.timeline.reasons.join()).toMatch(/timeline\.post\.created[\s\S]*post_timeline/);
    expect(JSON.stringify(report)).not.toContain('f'.repeat(48));
    expect(report.platformWrites).toEqual([]);
    expect(report.dropped.map((d: { what: string }) => d.what).join()).toMatch(/app scope user[\s\S]*lookup unused/);
    // nothing was written anywhere: no app, no platform write; the dry run is audited
    expect(await h.s.db('apps').where({ tenant_id: h.tenantId, name: 'cortex_platform' }).first()).toBeUndefined();
    expect(fake.writes).toEqual([]);
    expect(await audits('app.platform-import.planned')).toHaveLength(1);
  });

  it('imports through the record service as a job, and a second run updates instead of duplicating', async () => {
    const a = await as('ops', ['system-admin']);
    const { run } = await importRun(a);
    expect(run.state).toBe('succeeded');
    expect(run.job).toMatchObject({ state: 'succeeded', progress: 100 });
    expect(run.summary.records).toMatchObject({ created: 6, failed: 2 });
    const app = await h.s.db('apps').where({ tenant_id: h.tenantId, name: 'cortex_platform' }).first();
    expect(app).toMatchObject({ label: 'internal', workspace_id: wsId });
    const entities = await h.s.db('app_entities').where({ app_id: app.id }).orderBy('name');
    expect(entities.map((e) => e.name)).toEqual(['feedback', 'kitchen', 'requests', 'tasks']);
    // records went through the service: audited, sourced import, states reached along the transitions
    const records = await h.s.db('app_records').where({ app_id: app.id });
    expect(records).toHaveLength(6);
    expect(new Set(records.map((r) => r.source))).toEqual(new Set(['import']));
    expect((await audits('app.record.created')).length).toBe(6);
    const req = entities.find((e) => e.name === 'requests');
    expect(records.filter((r) => r.entity_id === req.id).map((r) => r.state).sort()).toEqual(['answered', 'closed', 'escalated']);
    expect((await audits('app.record.transitioned')).length).toBeGreaterThanOrEqual(4);
    const failed = run.report.filter((x: { result: string }) => x.result === 'failed');
    expect(failed).toHaveLength(2);
    expect(failed.map((x: { problems: string[] }) => x.problems.join()).join('\n')).toMatch(/not imported[\s\S]*unique|unique[\s\S]*not imported/);
    // forms and flows: imported flows are off and compiled into workflows
    expect((await h.s.db('app_forms').where({ app_id: app.id })).map((f) => f.name).sort()).toEqual(['ask', 'new_task']);
    const nt = JSON.parse((await h.s.db('app_forms').where({ app_id: app.id, name: 'new_task' }).first()).definition);
    expect(nt).toMatchObject({ version: 2, layout: { mode: 'wizard', steps: [{ title: 'Task' }, { title: 'Who and when' }] } });
    expect(nt.fields.find((f: { field: string }) => f.field === 'priority').visibleIf).toEqual({ any: [{ field: 'owner', op: 'exists' }] });
    const flows = await h.s.db('app_flows').where({ app_id: app.id }).orderBy('name');
    expect(flows.map((f) => [f.name, !!f.enabled])).toEqual([['escalate_high', false], ['hook_in', false], ['nightly', false], ['request_needs_person', false]]);
    expect(await h.s.db('workflows').where({ id: flows[0].workflow_id }).first()).toMatchObject({ published_version: 1 });
    expect(await audits('app.platform-import.started')).toHaveLength(1);
    expect(await audits('app.platform-import.finished')).toHaveLength(1);
    expect(fake.writes).toEqual([]);

    // the platform changes a record and adds one; the import runs again
    const fa = fake.apps[0]!;
    fa.records.get('requests')![0]!.data.urgency = 'high';
    fa.records.get('requests')!.push({ id: randomUUID(), data: { subject: 'A new one', kind: 'question' }, state: 'new' });
    const list = (await a.get('/api/apps/platform-import/apps').expect(200)).body;
    expect(list.apps[0].imported).toMatchObject({ name: 'cortex_platform' });
    const second = await importRun(a, { target: { mode: 'new', name: 'something_else', label: 'internal' } });
    expect(second.plan.report.target).toMatchObject({ mode: 'linked', name: 'cortex_platform' });
    expect(second.plan.report.warnings.join()).toMatch(/imported before/);
    expect(second.plan.report.entities.every((e: { action: string }) => e.action === 'unchanged')).toBe(true);
    expect(second.run.summary.records).toMatchObject({ created: 1, updated: 1, unchanged: 5, failed: 2 });
    expect(second.run.summary.forms).toMatchObject({ unchanged: 2 });
    expect(second.run.summary.flows).toMatchObject({ unchanged: 4, updated: 0, created: 0 });
    expect(await h.s.db('app_records').where({ app_id: app.id })).toHaveLength(7);
    expect(await h.s.db('apps').where({ tenant_id: h.tenantId }).whereIn('name', ['cortex_platform', 'something_else'])).toHaveLength(1);
    expect(await h.s.db('app_flows').where({ app_id: app.id })).toHaveLength(4);
  });

  it('refuses an import whose platform design changed since the dry run', async () => {
    const a = await as('ops', ['system-admin']);
    const plan = (await a.post('/api/apps/platform-import/plan', { platformApp: 'cortex', target }).expect(200)).body;
    fake.apps[0]!.entities[0]!.fields.push({ key: 'extra', label: 'Extra', type: 'string' });
    const started = (await a.post('/api/apps/platform-import/runs', { planId: plan.id }).expect(202)).body;
    await a.post('/api/apps/platform-import/runs', { planId: plan.id }).expect(409);
    await drain(h);
    const run = (await a.get(`/api/apps/platform-import/runs/${started.id}`).expect(200)).body;
    expect(run).toMatchObject({ state: 'failed', error: expect.stringMatching(/design changed/) });
    expect(await h.s.db('apps').where({ tenant_id: h.tenantId, name: 'cortex_platform' }).first()).toBeUndefined();
    expect(await audits('app.platform-import.failed')).toHaveLength(1);
  });

  it('merges into an existing app by name, and marks the platform app only when asked', async () => {
    const a = await as('ops', ['system-admin']);
    await a.post('/api/apps', { name: 'cortex', title: 'Cortex', label: 'internal', workspaceId: wsId }).expect(201);
    await a.post('/api/apps/cortex/entities', { name: 'requests', title: 'Requests', definition: { fields: [{ name: 'subject', type: 'string', required: true, maxLength: 300 }, { name: 'kind', type: 'enum', options: [{ value: 'question' }] }, { name: 'local_note', type: 'string' }] } }).expect(201);
    const into = { mode: 'existing', name: 'cortex' };
    const plan = (await a.post('/api/apps/platform-import/plan', { platformApp: 'cortex', target: into, options: { markPlatform: true } }).expect(200)).body;
    const req = plan.report.entities.find((e: { source: string }) => e.source === 'requests');
    expect(req.action).toBe('update');
    expect(req.changed).toEqual(expect.arrayContaining(['kind: options request, incident added', 'body: added', 'state machine added']));
    expect(req.changed.join()).not.toMatch(/subject/);
    expect(plan.report.platformWrites).toEqual([{ method: 'POST', path: '/lowcode/api/design/lookups', purpose: expect.stringMatching(/exprsn_ai_link/) }]);
    await a.post('/api/apps/platform-import/runs', { planId: plan.id }).expect(202);
    await drain(h);
    const def = JSON.parse((await h.s.db('app_entities').where({ name: 'requests' }).first()).definition);
    expect(def.fields.map((f: { name: string }) => f.name)).toEqual(expect.arrayContaining(['subject', 'kind', 'local_note', 'body', 'urgency', 'needs_person']));
    expect(def.fields.find((f: { name: string }) => f.name === 'subject').maxLength).toBe(300);
    // the only platform write: the link lookup, audited; nothing deleted
    expect(fake.writes).toHaveLength(1);
    expect(fake.writes[0]).toMatchObject({ method: 'POST', path: '/lowcode/api/design/lookups', body: { key: 'exprsn_ai_link', values: [expect.objectContaining({ label: expect.stringMatching(/\/cortex$/) })] } });
    expect(fake.refused).toEqual([]);
    expect(await audits('app.platform-import.platform-write')).toHaveLength(1);
    const listed = (await a.get('/api/apps/platform-import/apps').expect(200)).body;
    expect(listed.apps[0].markedOnPlatform).toHaveLength(1);
    // a second marked import updates the lookup in place (and does not import it as a field option)
    const again = (await a.post('/api/apps/platform-import/plan', { platformApp: 'cortex', target: into, options: { markPlatform: true } }).expect(200)).body;
    expect(again.report.platformWrites[0].method).toBe('PUT');
    expect(JSON.stringify(again.report.dropped)).not.toMatch(/exprsn_ai_link/);
    await a.post('/api/apps/platform-import/runs', { planId: again.id }).expect(202);
    await drain(h);
    expect(fake.writes.map((w) => w.method)).toEqual(['POST', 'PUT']);
    expect((fake.writes[1]!.body as { values: unknown[] }).values).toHaveLength(1);
  });

  it('leaves records and flows out when asked', async () => {
    const a = await as('ops', ['system-admin']);
    const plan = (await a.post('/api/apps/platform-import/plan', { platformApp: 'cortex', target, options: { records: false, flows: false } }).expect(200)).body;
    expect(plan.report.records.total).toBe(0);
    expect(plan.report.flows).toEqual([]);
    expect(plan.report.dropped.map((d: { what: string }) => d.what).join()).toMatch(/8 flow/);
  });
});
