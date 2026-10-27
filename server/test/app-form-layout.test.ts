import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { conditionMatches, layoutProblems, planForm, stepProblems, type LayoutDefinition } from '../src/apps/form-layout.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';

/*
 * Follow-up 2 of docs/decisions/lowcode-port.md: form sections, wizard steps and `visibleIf` / `requiredIf` condition
 * trees on fields, sections and steps. Flat forms keep working as they were; a wizard's required fields are checked
 * per step; a field hidden by a condition (its own, its section's or its step's) is dropped and never stored;
 * `requiredIf` is enforced; held submissions are still held; public link and embed submissions take the same path;
 * and the browser's evaluator (web/js/form-layout.js) decides exactly what the server decides.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

const ticket = {
  fields: [
    { name: 'email', type: 'string', required: true, maxLength: 200 },
    { name: 'kind', type: 'enum', options: [{ value: 'person' }, { value: 'company' }] },
    { name: 'company_name', type: 'string', maxLength: 120 },
    { name: 'size', type: 'number', min: 0 },
    { name: 'urgent', type: 'boolean' },
    { name: 'reason', type: 'string', maxLength: 200 },
    { name: 'note', type: 'string', multiline: true, maxLength: 500 }
  ]
};

/** A wizard of three steps; the company step only for companies; the details step all required for companies. */
const wizard = {
  fields: [
    { field: 'note', label: 'Anything else' },
    { field: 'email', required: true },
    { field: 'kind' },
    { field: 'company_name', required: true, label: 'Company' },
    { field: 'size', requiredIf: { any: [{ field: 'company_name', op: 'contains', value: 'ltd' }, { field: 'company_name', op: 'contains', value: 'gmbh' }] } },
    { field: 'urgent' },
    { field: 'reason', visibleIf: { field: 'urgent', op: 'truthy' }, requiredIf: { field: 'urgent', op: 'truthy' } }
  ],
  layout: {
    mode: 'wizard',
    review: true,
    sections: [
      { id: 'contact', title: 'Contact', fields: ['email', 'kind'] },
      { id: 'company', title: 'Company', help: 'Only for companies.', fields: ['company_name', 'size'] },
      { id: 'details', title: 'Details', collapsible: true, fields: ['urgent', 'reason', 'note'] }
    ],
    steps: [
      { id: 'who', title: 'Who you are', sections: ['contact'] },
      { id: 'org', title: 'Your company', sections: ['company'], visibleIf: { field: 'kind', op: 'eq', value: 'Company' } },
      { id: 'more', title: 'More', sections: ['details'], requiredIf: { all: [{ field: 'kind', op: 'eq', value: 'company' }, { none: [{ field: 'size', op: 'lt', value: 10 }] }] } }
    ]
  },
  successMessage: 'Thanks.'
};

describe('follow-up 2: form sections, wizard steps and condition trees', () => {
  let h: Harness;
  let wsId: string;
  beforeEach(async () => {
    h = await harness({ APPS_PUBLIC_FORM_PER_MINUTE: '100' });
    wsId = (await h.s.tenants.createWorkspace(h.tenantId, 'Support', 'confidential')).id;
  });
  afterEach(async () => {
    await h.close();
  });

  async function wrap(c: { agent: Client['agent']; csrf: string }) {
    const send = (method: 'post' | 'patch' | 'put' | 'delete', p: string, body: object = {}) => c.agent[method](p).set('x-csrf-token', c.csrf).send(body);
    await send('put', '/api/me/workspace', { workspaceId: wsId }).expect(200);
    return { ...c, post: (p: string, b?: object) => send('post', p, b), put: (p: string, b?: object) => send('put', p, b), patch: (p: string, b?: object) => send('patch', p, b), get: (p: string) => c.agent.get(p) };
  }
  async function admin(name: string, roles: string[]) {
    const u = await localUser(h, name, roles, 'confidential');
    await h.s.tenants.addMember(wsId, u.id);
    return { user: u, ...(await wrap(roles.some((r) => r !== 'member') ? await loginAdmin(h, name) : await login(h, name))) };
  }
  async function setup() {
    const d = await admin('dee', ['workflow-admin', 'member']);
    await d.post('/api/apps', { name: 'desk', title: 'Desk', label: 'confidential', workspaceId: wsId }).expect(201);
    await d.post('/api/apps/desk/entities', { name: 'ticket', label: 'internal', definition: ticket }).expect(201);
    return d;
  }
  const records = async (d: Awaited<ReturnType<typeof setup>>) => ((await d.get('/api/apps/desk/ticket?limit=50').expect(200)).body as { records: { values: Record<string, unknown>; source: string }[] }).records;

  it('a flat form is unchanged: stored as sent, described as one section, its one-leaf condition evaluated as before', async () => {
    const d = await setup();
    const flat = { fields: [{ field: 'email' }, { field: 'kind' }, { field: 'company_name', visibleIf: { field: 'kind', op: 'in', value: ['Company'] } }] };
    await d.post('/api/apps/desk/forms', { name: 'flat', entity: 'ticket', definition: flat }).expect(201);
    const made = (await d.get('/api/apps/desk/forms/flat').expect(200)).body as { definition: unknown; shown: { version: number; layout: { mode: string; sections: { id: string; fields: string[]; title: null }[]; steps: unknown[] } } };
    expect(made.definition).toEqual(flat); // no version, no layout written
    expect(made.shown.version).toBe(1);
    expect(made.shown.layout).toMatchObject({ mode: 'sections', steps: [], sections: [{ id: 'main', title: null, fields: ['email', 'kind', 'company_name'] }] });
    const row = await h.s.db('app_forms').where({ name: 'flat' }).first();
    expect(JSON.parse(row.definition as string)).toEqual(flat);
    // Hidden for a person (dropped), shown for a company (text compares without regard to case, as before).
    const a = (await d.post('/api/apps/desk/forms/flat/submit', { values: { email: 'a@x.test', kind: 'person', company_name: 'Hidden Ltd' } }).expect(201)).body as { dropped: string[] };
    expect(a.dropped).toEqual(['company_name']);
    await d.post('/api/apps/desk/forms/flat/submit', { values: { email: 'b@x.test', kind: 'company', company_name: 'Shown Ltd' } }).expect(201);
    const recs = await records(d);
    expect(recs.find((r) => r.values.email === 'a@x.test')!.values.company_name).toBeUndefined();
    expect(recs.find((r) => r.values.email === 'b@x.test')!.values.company_name).toBe('Shown Ltd');
    // A form stored before layouts (written straight to the table) still opens and submits.
    await h.s.db('app_forms').where({ name: 'flat' }).update({ definition: JSON.stringify({ fields: [{ field: 'email', required: true }, { field: 'note', visibleIf: { field: 'email', op: 'truthy' } }], submitLabel: 'Go' }) });
    const shown = (await d.get('/api/apps/desk/forms/flat').expect(200)).body as { shown: { submitLabel: string; fields: { name: string }[] } };
    expect(shown.shown.submitLabel).toBe('Go');
    expect(shown.shown.fields.map((f) => f.name)).toEqual(['email', 'note']);
    expect((await d.post('/api/apps/desk/forms/flat/submit', { values: { note: 'x' } }).expect(400)).body.detail).toBe('email is required.');
  });

  it('a wizard is stored as version 2 in layout order, described with its steps, and a bad layout is refused', async () => {
    const d = await setup();
    await d.post('/api/apps/desk/forms', { name: 'intake', title: 'Intake', entity: 'ticket', definition: wizard }).expect(201);
    const made = (await d.get('/api/apps/desk/forms/intake').expect(200)).body as { definition: { version: number; fields: { field: string }[] }; shown: { version: number; layout: { mode: string; review: boolean; steps: { id: string; title: string; sections: string[]; visibleIf: unknown }[]; sections: { id: string; collapsible: boolean }[] }; fields: { name: string; requiredIf: unknown }[] } };
    expect(made.definition.version).toBe(2);
    expect(made.definition.fields.map((f) => f.field)).toEqual(['email', 'kind', 'company_name', 'size', 'urgent', 'reason', 'note']);
    expect(made.shown.layout.mode).toBe('wizard');
    expect(made.shown.layout.review).toBe(true);
    expect(made.shown.layout.steps.map((s) => s.id)).toEqual(['who', 'org', 'more']);
    expect(made.shown.layout.steps[1]!.visibleIf).toEqual({ field: 'kind', op: 'eq', value: 'Company' });
    expect(made.shown.layout.sections.find((s) => s.id === 'details')!.collapsible).toBe(true);
    expect(made.shown.fields.find((f) => f.name === 'reason')!.requiredIf).toEqual({ field: 'urgent', op: 'truthy' });
    const audit = await h.s.db('audit_events').where({ tenant_id: h.tenantId, action: 'app.form.created' }).first();
    expect(audit).toBeTruthy();

    const refuse = async (definition: unknown, match: RegExp) => {
      const r = await d.patch('/api/apps/desk/forms/intake', { definition }).expect(400);
      const all = [r.body.detail, ...((r.body.problems ?? []) as string[]), ...((r.body.errors ?? []) as { message: string }[]).map((e) => e.message)].join(' | ');
      expect(all).toMatch(match);
    };
    const L = wizard.layout;
    await refuse({ ...wizard, layout: { ...L, sections: [L.sections[0], { ...L.sections[1], fields: ['company_name', 'size', 'email'] }, L.sections[2]] } }, /email is in sections contact and company/);
    await refuse({ ...wizard, fields: wizard.fields.map((f) => (f.field === 'kind' ? { field: 'kind', visibleIf: { field: 'urgent', op: 'truthy' } } : f)) }, /kind depends on urgent, which must come earlier/);
    await refuse({ ...wizard, layout: { ...L, steps: L.steps.slice(0, 2) } }, /Section details is in no step/);
    await refuse({ ...wizard, layout: { ...L, steps: [{ ...L.steps[0], visibleIf: { field: 'email', op: 'exists' } }, ...L.steps.slice(1)] } }, /Step who \(visible if\) depends on email, which must come earlier/);
    await refuse({ ...wizard, fields: wizard.fields.map((f) => (f.field === 'note' ? { field: 'note', visibleIf: { all: [] } } : f)) }, /a group needs at least one comparison/);
    await refuse({ ...wizard, layout: { mode: 'sections', sections: L.sections, steps: L.steps } }, /Steps need the wizard mode/);
    await refuse({ ...wizard, fields: wizard.fields.map((f) => (f.field === 'note' ? { field: 'note', visibleIf: { field: 'size', op: 'gt' } } : f)) }, /size gt takes one value/);
    await refuse({ ...wizard, layout: { ...L, sections: L.sections.map((s) => (s.id === 'details' ? { ...s, fields: ['urgent', 'reason'] } : s)) } }, /note is on the form but in no section/);
    // Moving back to a flat list: the layout is gone, the fields keep their order.
    const flat = (await d.patch('/api/apps/desk/forms/intake', { definition: { fields: [{ field: 'email' }, { field: 'note' }] } }).expect(200)).body as { definition: { version?: number; layout?: unknown } };
    expect(flat.definition.layout).toBeUndefined();
    expect(flat.definition.version).toBeUndefined();
  });

  it('checks each wizard step, drops what a condition hides and enforces requiredIf on fields, sections and steps', async () => {
    const d = await setup();
    await d.post('/api/apps/desk/forms', { name: 'intake', entity: 'ticket', definition: wizard }).expect(201);
    const def = wizard as unknown as LayoutDefinition;
    // Per step: the first step asks for the email; the company step exists only for companies.
    expect(stepProblems(def, {}, 'who').map((m) => m.field)).toEqual(['email']);
    expect(planForm(def, { email: 'a@x.test', kind: 'person' }).steps).toEqual(['who', 'more']);
    expect(planForm(def, { email: 'a@x.test', kind: 'company' }).steps).toEqual(['who', 'org', 'more']);
    expect(stepProblems(def, { email: 'a@x.test', kind: 'company' }, 'org').map((m) => m.field)).toEqual(['company_name']);
    expect(stepProblems(def, { email: 'a@x.test', kind: 'company', company_name: 'Acme Ltd' }, 'org').map((m) => m.field)).toEqual(['size']);
    expect(stepProblems(def, { email: 'a@x.test', kind: 'company', company_name: 'Acme Inc' }, 'org')).toEqual([]);

    // A person: the company step is hidden, so its answers are dropped and never stored; reason is hidden while not urgent.
    const p = (await d.post('/api/apps/desk/forms/intake/submit', { values: { email: 'p@x.test', kind: 'person', company_name: 'Sneaky Ltd', size: 5, urgent: false, reason: 'hidden', note: 'hi', extra: 1 } }).expect(201)).body as { id: string; dropped: string[] };
    expect(p.dropped.sort()).toEqual(['company_name', 'extra', 'reason', 'size']);
    const stored = await h.s.db('app_records').where({ id: p.id }).first();
    expect(JSON.stringify(stored)).not.toContain('Sneaky');
    expect((await records(d)).find((r) => r.values.email === 'p@x.test')!.values).toEqual({ email: 'p@x.test', kind: 'person', urgent: false, note: 'hi' });

    // A company: company name required in the company step (problems name the step), size required for a Ltd.
    const missing = (await d.post('/api/apps/desk/forms/intake/submit', { values: { email: 'c@x.test', kind: 'company' } }).expect(400)).body as { problems: { field: string; step: string; section: string }[] };
    expect(missing.problems[0]).toEqual({ field: 'company_name', message: 'is required', step: 'org', section: 'company' });
    const ltd = (await d.post('/api/apps/desk/forms/intake/submit', { values: { email: 'c@x.test', kind: 'company', company_name: 'Acme Ltd', urgent: false, note: 'n' } }).expect(400)).body as { problems: { field: string; step: string }[] };
    expect(ltd.problems.map((x) => [x.field, x.step])).toEqual([['size', 'org']]);
    // The details step is required for a company of 10 or more (step requiredIf with a none group): urgent and note.
    const big = (await d.post('/api/apps/desk/forms/intake/submit', { values: { email: 'c@x.test', kind: 'company', company_name: 'Acme Ltd', size: 40 } }).expect(400)).body as { problems: { field: string; step: string }[] };
    expect(big.problems.map((x) => [x.field, x.step])).toEqual([['urgent', 'more'], ['note', 'more']]);
    // Urgent: the reason shows and is required (field requiredIf).
    const urgent = (await d.post('/api/apps/desk/forms/intake/submit', { values: { email: 'c@x.test', kind: 'company', company_name: 'Acme Ltd', size: 40, urgent: true, note: 'n' } }).expect(400)).body as { problems: { field: string }[] };
    expect(urgent.problems.map((x) => x.field)).toEqual(['reason']);
    await d.post('/api/apps/desk/forms/intake/submit', { values: { email: 'c@x.test', kind: 'company', company_name: 'Acme Ltd', size: 40, urgent: true, reason: 'outage', note: 'n' } }).expect(201);
    // A small company needs no details.
    await d.post('/api/apps/desk/forms/intake/submit', { values: { email: 's@x.test', kind: 'company', company_name: 'Tiny GmbH', size: 3 } }).expect(201);
    expect((await records(d)).find((r) => r.values.email === 's@x.test')!.values.size).toBe(3);
  });

  it('public link and embed submissions take the same path, and a held public submission is still held without its hidden fields', async () => {
    const d = await setup();
    await d.post('/api/apps/desk/forms', { name: 'intake', title: 'Intake', entity: 'ticket', definition: wizard }).expect(201);
    const { token } = (await d.post('/api/apps/desk/forms/intake/public', { enabled: true }).expect(200)).body as { token: string };
    const anon = request(h.app);
    // The public link page: a static shell under its own CSP, not framed, the token never in a URL.
    const page = await anon.get('/form').expect(200);
    expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(page.headers['content-security-policy']).toContain("script-src 'self'");
    expect(page.text).toContain('data-kind="link"');
    expect(page.text).toContain('/js/form-layout.js');
    expect(page.text).not.toMatch(/<script>/);
    const opened = (await anon.post('/api/public/forms/open').send({ token }).expect(200)).body as { layout: { mode: string; steps: unknown[] }; version: number };
    expect(opened.layout.mode).toBe('wizard');
    expect(opened.layout.steps).toHaveLength(3);
    expect(opened.version).toBe(2);
    const bad = (await anon.post('/api/public/forms/submit').send({ token, values: { email: 'q@x.test', kind: 'company' } }).expect(400)).body as { problems: { field: string; step: string }[] };
    expect(bad.problems[0]).toMatchObject({ field: 'company_name', step: 'org' });
    const ok = (await anon.post('/api/public/forms/submit').send({ token, values: { email: 'q@x.test', kind: 'person', company_name: 'Dropped Ltd', note: 'hello' } }).expect(201)).body as { dropped: number; message: string };
    expect(ok).toMatchObject({ dropped: 1, message: 'Thanks.' });

    // The embed page: same layout, same checks.
    await d.put('/api/apps/desk/embed', { publicEnabled: true, allowedHosts: ['https://example.com'] }).expect(200);
    const emb = (await d.post('/api/apps/desk/embed/pages', { form: 'intake' }).expect(201)).body as { id: string };
    const html = await anon.get(`/embed/${emb.id}`).expect(200);
    expect(html.text).toContain('/js/form-layout.js');
    expect(((await anon.post('/api/public/embeds/open').send({ embed: emb.id }).expect(200)).body as { layout: { mode: string } }).layout.mode).toBe('wizard');
    const eb = (await anon.post('/api/public/embeds/submit').send({ embed: emb.id, values: { email: 'e@x.test', kind: 'company', company_name: 'Acme Ltd', urgent: false } }).expect(400)).body as { problems: { field: string; step: string }[] };
    expect(eb.problems[0]).toMatchObject({ field: 'size', step: 'org' });
    await anon.post('/api/public/embeds/submit').send({ embed: emb.id, values: { email: 'e@x.test', kind: 'person', size: 9 } }).expect(201);
    const recs = await records(d);
    expect(recs.filter((r) => r.source === 'form').map((r) => r.values.email).sort()).toEqual(['e@x.test', 'q@x.test']);
    expect(recs.find((r) => r.values.email === 'e@x.test')!.values.size).toBeUndefined();

    // A guardrail rule holds "wire transfer": the wizard's public submission waits for review, without hidden values.
    const ga = await admin('ga', ['guardrail-admin']);
    const set = (await ga.post('/api/admin/guardrails/sets', { name: 'Form rules', scope: 'tenant' }).expect(201)).body;
    await ga.put(`/api/admin/guardrails/sets/${set.id}/draft`, { rules: [{ id: 'wire', name: 'Wire transfers', checkpoint: 'user-input', type: 'pattern', mechanism: { kind: 'pattern', pattern: '(?i)wire transfer' }, action: 'require-approval', stage: 'enforce' }] }).expect(200);
    await ga.post(`/api/admin/guardrails/sets/${set.id}/draft/publish`).expect(200);
    const held = (await anon.post('/api/public/forms/submit').send({ token, values: { email: 'w@x.test', kind: 'person', company_name: 'Secret Ltd', note: 'Please send the wire transfer' } }).expect(202)).body as { held: boolean; dropped: number };
    expect(held).toMatchObject({ held: true, dropped: 1 });
    const hold = await h.s.db('app_form_holds').first();
    const text = await h.s.apps.forms.held.heldText(h.tenantId, hold.id as string);
    expect(text!.content).toContain('wire transfer');
    expect(text!.content).not.toContain('Secret Ltd');
    expect((await records(d)).some((r) => r.values.email === 'w@x.test')).toBe(false);
  });

  it('the browser evaluator (web/js/form-layout.js) decides what the server decides', () => {
    const sandbox: { window: { ExprsnFormLayout?: { matches(c: unknown, v: unknown): boolean; plan(spec: unknown, v: unknown): { values: unknown; visible: string[]; steps: string[]; missing: { field: string; step: string }[] } } } } = { window: {} };
    vm.runInNewContext(readFileSync(path.join(here, '../../web/js/form-layout.js'), 'utf8'), sandbox);
    const B = sandbox.window.ExprsnFormLayout!;
    const conditions: unknown[] = [
      { field: 'a', op: 'eq', value: 'X' }, { field: 'a', op: 'ne', value: 'x' }, { field: 'a', op: 'in', value: ['Y', 'x'] }, { field: 'a', op: 'not_in', value: ['y'] },
      { field: 'n', op: 'gt', value: 3 }, { field: 'n', op: 'gte', value: '4' }, { field: 'n', op: 'lt', value: 10 }, { field: 'n', op: 'lte', value: 3 },
      { field: 'a', op: 'contains', value: 'X' }, { field: 'tags', op: 'contains', value: 'Red' }, { field: 'a', op: 'not_contains', value: 'z' },
      { field: 'a', op: 'exists' }, { field: 'e', op: 'not_exists' }, { field: 'b', op: 'truthy' }, { field: 'z', op: 'falsy' }, { field: 'n', op: 'gt', value: 'abc' },
      { all: [{ field: 'a', op: 'exists' }, { any: [{ field: 'n', op: 'lt', value: 2 }, { none: [{ field: 'b', op: 'falsy' }] }] }] },
      { any: [] }, { none: [{ field: 'a', op: 'eq', value: 'x' }] }
    ];
    const inputs = [{ a: 'x', n: 4, b: true, tags: ['red', 'blue'], e: '' }, { a: 'Ä', n: '3', b: false, z: 0 }, {}, { a: '', n: null, b: 'no' }];
    for (const c of conditions) for (const v of inputs) expect(B.matches(c, v), JSON.stringify({ c, v })).toBe(conditionMatches(c as never, v as never));
    const spec = { fields: wizard.fields.map((f) => ({ name: f.field, required: !!f.required, visibleIf: (f as { visibleIf?: unknown }).visibleIf ?? null, requiredIf: (f as { requiredIf?: unknown }).requiredIf ?? null })), layout: wizard.layout };
    const answers = [{}, { email: 'a', kind: 'person', company_name: 'x Ltd' }, { email: 'a', kind: 'COMPANY', company_name: 'x Ltd', size: 40, urgent: true }, { email: 'a', kind: 'company', company_name: 'y gmbh', size: 2, urgent: false, reason: 'r' }];
    for (const v of answers) {
      const server = planForm(wizard as unknown as LayoutDefinition, v);
      const browser = B.plan(spec, v);
      expect(JSON.parse(JSON.stringify({ values: browser.values, visible: browser.visible, steps: browser.steps, missing: browser.missing.map((m) => [m.field, m.step]) }))).toEqual({ values: server.values, visible: server.visible, steps: server.steps, missing: server.missing.map((m) => [m.field, m.step]) });
    }
    // A flat definition laid out the same way on both sides.
    expect(B.plan({ fields: [{ name: 'a' }, { name: 'b', visibleIf: { field: 'a', op: 'truthy' } }] }, { b: 1 }).visible).toEqual(planForm({ fields: [{ field: 'a' }, { field: 'b', visibleIf: { field: 'a', op: 'truthy' } }] }, { b: 1 }).visible);
    expect(layoutProblems(wizard as unknown as LayoutDefinition)).toEqual([]);
  });
});
