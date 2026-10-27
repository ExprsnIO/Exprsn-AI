import { ulid } from 'ulid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { harness, localUser, login, loginAdmin, type Harness } from './helpers.js';

/*
 * 1.9.0: notification templates (migration 132, `platform/notification-templates.ts`). Made, versioned and deleted by a
 * tenant admin (`tenant:manage`); mandatory kinds refused; applied to one person, a list, a role, a group and everyone,
 * in `replace` and `fill`; people customise afterwards and Settings says which template and version they are based
 * on; new members get the tenant's default template; every change audited; and without the tables, nothing changes.
 * The migration is applied here by hand until it is registered in `db/migrations/index.ts`.
 */

const OFF = { enabled: false, timing: 'instant' } as const;
const DAILY = { enabled: true, timing: 'daily' } as const;

async function install(h: Harness): Promise<void> {
  if (!(await h.s.db.schema.hasTable('notification_templates'))) await (await import('../src/db/migrations/132_notification_templates.js')).up(h.s.db);
  h.s.notificationPrefs.templates.resetSchemaCache();
}

describe('notification templates', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(async () => {
    await h.s.notificationPrefs.templates.settled();
    await h.close();
  });

  const audits = async (prefix: string) => ((await h.s.audit.list(h.tenantId, { limit: 500 })) as { action: string; kind: string; detail: Record<string, unknown> | null; target: Record<string, unknown> }[]).filter((e) => e.action.startsWith(prefix));
  const admin = async () => {
    await localUser(h, 'ta', ['tenant-admin'], 'confidential');
    const a = await loginAdmin(h, 'ta');
    return {
      ...a,
      get: (p: string) => a.agent.get(p),
      post: (p: string, b: object) => a.agent.post(p).set('x-csrf-token', a.csrf).send(b),
      patch: (p: string, b: object) => a.agent.patch(p).set('x-csrf-token', a.csrf).send(b),
      del: (p: string) => a.agent.delete(p).set('x-csrf-token', a.csrf)
    };
  };
  const kindOf = (view: { kinds: { id: string; channels: Record<string, { enabled: boolean; timing: string; source: string }> }[] }, id: string) => view.kinds.find((k) => k.id === id)!;

  it('tolerates the missing tables: not available, 503, no origin, new members unchanged', async () => {
    // The harness runs 132 since it was registered (2026-10-18): drop it to see the services without it.
    await (await import('../src/db/migrations/132_notification_templates.js')).down(h.s.db);
    const ta = await admin();
    const list = (await ta.get('/api/admin/notification-templates').expect(200)).body;
    expect(list).toEqual({ available: false, templates: [], targets: { roles: [], groups: [] } });
    const refused = await ta.post('/api/admin/notification-templates', { name: 'Quiet', kinds: {} }).expect(503);
    expect(refused.headers['content-type']).toMatch(/problem\+json/);
    expect(refused.body.reason).toBe('migration_pending');
    await ta.post(`/api/admin/notification-templates/${ulid()}/apply`, { mode: 'fill', target: { kind: 'everyone' } }).expect(503);
    const ana = await localUser(h, 'ana', ['member']);
    await h.s.notificationPrefs.templates.settled();
    expect(await h.s.db('notification_pref_rules').where({ user_id: ana.id })).toEqual([]);
    const c = await login(h, 'ana');
    const view = (await c.agent.get('/api/me/notification-preferences').expect(200)).body;
    expect(view).toMatchObject({ saved: false, template: null });
    await c.agent.delete('/api/me/notification-preferences').set('x-csrf-token', c.csrf).expect(200);
  });

  it('creates, versions and deletes a template; refuses mandatory kinds; only tenant admins; audited', async () => {
    await install(h);
    const ta = await admin();
    await localUser(h, 'ana', ['member']);
    const ana = await login(h, 'ana');
    await ana.agent.get('/api/admin/notification-templates').expect(403);

    const made = (await ta.post('/api/admin/notification-templates', { name: 'Focus', description: 'Few interruptions', kinds: { feed: { email: OFF, push: OFF }, workflow: { email: DAILY } }, quietHours: { mon: { start: '22:00', end: '07:00' } }, urgentPassesQuiet: true, digestHour: 9, digestWeekday: 4 }).expect(201)).body;
    expect(made).toMatchObject({ name: 'Focus', description: 'Few interruptions', version: 1, defaultForNewMembers: false, digestHour: 9, digestWeekday: 4, quietHours: { mon: { start: '22:00', end: '07:00' } }, people: 0 });
    expect(made.kinds.workflow).toEqual({ email: DAILY });
    expect(made.versions.map((v: { version: number }) => v.version)).toEqual([1]);
    await ta.post('/api/admin/notification-templates', { name: 'Focus', kinds: {} }).expect(409);
    await ta.post('/api/admin/notification-templates', { name: 'Bad', kinds: { 'no-such': { email: OFF } } }).expect(400);

    // Security alerts are mandatory everywhere: no template turns them off or into a digest.
    const locked = await ta.post('/api/admin/notification-templates', { name: 'Silent', kinds: { security: { email: OFF }, chat: { push: OFF } } }).expect(409);
    expect(locked.body.kinds).toEqual(['security']);
    expect(locked.body.detail).toMatch(/Security alerts is mandatory/);
    await ta.post('/api/admin/notification-templates', { name: 'Delayed', kinds: { security: { in_app: DAILY } } }).expect(409);
    // A kind the tenant made mandatory, likewise.
    await h.s.notificationPrefs.updateTenant({ ...(await principalOf(h, 'ta')) }, { kinds: { flag: { mandatory: true } } });
    const tenantLocked = await ta.patch(`/api/admin/notification-templates/${made.id}`, { kinds: { flag: { email: OFF } } }).expect(409);
    expect(tenantLocked.body.kinds).toEqual(['flag']);

    const edited = (await ta.patch(`/api/admin/notification-templates/${made.id}`, { kinds: { feed: { email: OFF } }, digestHour: 7 }).expect(200)).body;
    expect(edited).toMatchObject({ version: 2, digestHour: 7, digestWeekday: 4 });
    expect(edited.kinds).toEqual({ feed: { email: OFF } });
    expect(edited.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    // Setting the default only is not a new version.
    const dflt = (await ta.patch(`/api/admin/notification-templates/${made.id}`, { defaultForNewMembers: true }).expect(200)).body;
    expect(dflt).toMatchObject({ version: 2, defaultForNewMembers: true });
    // One default per tenant.
    const other = (await ta.post('/api/admin/notification-templates', { name: 'Other', kinds: {}, defaultForNewMembers: true }).expect(201)).body;
    const list = (await ta.get('/api/admin/notification-templates').expect(200)).body;
    expect(list.available).toBe(true);
    expect(list.templates.map((t: { name: string; defaultForNewMembers: boolean }) => [t.name, t.defaultForNewMembers])).toEqual([['Focus', false], ['Other', true]]);

    await ta.del(`/api/admin/notification-templates/${other.id}`).expect(200);
    await ta.get(`/api/admin/notification-templates/${other.id}`).expect(404);
    expect(await h.s.db('notification_template_versions').where({ template_id: other.id })).toEqual([]);
    const a = await audits('notification.template.');
    expect(a.map((e) => e.action)).toEqual(expect.arrayContaining(['notification.template.created', 'notification.template.updated', 'notification.template.deleted']));
    expect(a.filter((e) => e.action === 'notification.template.created')).toHaveLength(2);
    expect(a.filter((e) => e.action === 'notification.template.updated')).toHaveLength(2);
    expect(a.find((e) => e.action === 'notification.template.deleted')!.detail).toMatchObject({ name: 'Other' });
  });

  it('applies to one person, a list, a role, a group and everyone; replace and fill; customisable after; based on', async () => {
    await install(h);
    const ta = await admin();
    const ana = await localUser(h, 'ana', ['member']);
    const ben = await localUser(h, 'ben', ['member']);
    const cy = await localUser(h, 'cy', ['auditor']);
    const tpl = (await ta.post('/api/admin/notification-templates', { name: 'Focus', kinds: { feed: { email: OFF, push: OFF }, workflow: { email: DAILY } }, quietHours: { sat: { start: '22:00', end: '07:00' } }, digestHour: 9 }).expect(201)).body;
    const apply = (b: object) => ta.post(`/api/admin/notification-templates/${tpl.id}/apply`, b);

    // Ana chose something for workflow and feed's in-app herself, and a time zone.
    const ca = await login(h, 'ana');
    await ca.agent.put('/api/me/notification-preferences').set('x-csrf-token', ca.csrf).send({ timeZone: 'Europe/Lisbon', kinds: { workflow: { email: { enabled: false, timing: 'instant' } }, chat: { push: OFF } } }).expect(200);

    // A dry run counts and writes nothing.
    const dry = (await apply({ mode: 'replace', target: { kind: 'users', userIds: [ana.id] }, dryRun: true }).expect(200)).body;
    expect(dry).toMatchObject({ dryRun: true, people: 1, changedPeople: 1, changedKinds: 3 });
    expect((await h.s.notificationPrefs.decide(h.tenantId, ana.id, 'chat', 'push')).deliver).toBe('suppressed');
    expect((await audits('notification.template.applied'))).toHaveLength(0);

    // Fill leaves Ana's own workflow choice and sets feed.
    const fill = (await apply({ mode: 'fill', target: { kind: 'users', userIds: [ana.id] } }).expect(200)).body;
    expect(fill).toMatchObject({ template: { id: tpl.id, name: 'Focus', version: 1 }, mode: 'fill', people: 1, changedPeople: 1, changedKinds: 1 });
    let view = (await ca.agent.get('/api/me/notification-preferences').expect(200)).body;
    expect(kindOf(view, 'workflow').channels.email).toMatchObject({ enabled: false, timing: 'instant', source: 'you' });
    expect(kindOf(view, 'feed').channels.email).toMatchObject({ enabled: false, source: 'you' });
    expect(kindOf(view, 'chat').channels.push).toMatchObject({ enabled: false, source: 'you' });
    // She had settings saved, so fill sets only her empty quiet hours, not her digest hour.
    expect(view).toMatchObject({ timeZone: 'Europe/Lisbon', digestHour: 8, quietHours: { sat: { start: '22:00', end: '07:00' } } });
    expect(view.template).toMatchObject({ id: tpl.id, name: 'Focus', version: 1, currentVersion: 1, mode: 'fill', changedKinds: 0 });

    // Replace: her own choices go; the template's come; her time zone stays.
    const rep = (await apply({ mode: 'replace', target: { kind: 'users', usernames: ['ana', 'nobody'] } }).expect(200)).body;
    expect(rep).toMatchObject({ people: 1, unknown: ['nobody'], changedKinds: 2 });
    view = (await ca.agent.get('/api/me/notification-preferences').expect(200)).body;
    expect(kindOf(view, 'workflow').channels.email).toMatchObject({ enabled: true, timing: 'daily', source: 'you' });
    expect(kindOf(view, 'chat').channels.push!.source).toBe('default');
    expect(view).toMatchObject({ timeZone: 'Europe/Lisbon', digestHour: 9 });
    expect((await h.s.notificationPrefs.decide(h.tenantId, ana.id, 'feed', 'email')).deliver).toBe('suppressed');

    // Customisation afterwards works as usual, and Settings counts the kinds she changed since.
    await ca.agent.put('/api/me/notification-preferences').set('x-csrf-token', ca.csrf).send({ kinds: { feed: { email: { enabled: true, timing: 'weekly' } }, agent: { push: OFF } } }).expect(200);
    view = (await ca.agent.get('/api/me/notification-preferences').expect(200)).body;
    expect(kindOf(view, 'feed').channels.email).toMatchObject({ enabled: true, timing: 'weekly', source: 'you' });
    expect(view.template).toMatchObject({ name: 'Focus', version: 1, changedKinds: 2 });
    // A new version of the template shows as newer than hers.
    await ta.patch(`/api/admin/notification-templates/${tpl.id}`, { digestHour: 10 }).expect(200);
    expect((await ca.agent.get('/api/me/notification-preferences').expect(200)).body.template).toMatchObject({ version: 1, currentVersion: 2 });

    // A list of people.
    const list = (await apply({ mode: 'fill', target: { kind: 'users', userIds: [ben.id, cy.id] } }).expect(200)).body;
    expect(list).toMatchObject({ people: 2, changedPeople: 2, changedKinds: 4 });
    // A role: only the auditor.
    await h.s.db('notification_pref_rules').where({ user_id: cy.id }).delete();
    const role = (await apply({ mode: 'replace', target: { kind: 'role', role: 'auditor' } }).expect(200)).body;
    expect(role).toMatchObject({ people: 1, changedKinds: 2, template: { version: 2 } });
    expect((await h.s.notificationPrefs.decide(h.tenantId, cy.id, 'feed', 'push')).deliver).toBe('suppressed');
    // A group.
    const gid = ulid();
    const ws = (await h.s.db('workspaces').where({ tenant_id: h.tenantId }).first('id')) as { id: string } | undefined;
    await h.s.db('social_groups').insert({ id: gid, tenant_id: h.tenantId, workspace_id: ws?.id ?? ulid(), name: 'Night shift', visibility: 'private', join_mode: 'invite', label: 'internal', state: 'active', created_at: Date.now(), updated_at: Date.now() });
    await h.s.db('group_members').insert({ group_id: gid, tenant_id: h.tenantId, user_id: ben.id, role: 'member', joined_at: Date.now() });
    const group = (await apply({ mode: 'replace', target: { kind: 'group', groupId: gid } }).expect(200)).body;
    expect(group).toMatchObject({ target: 'group', people: 1 });
    await apply({ mode: 'replace', target: { kind: 'group', groupId: ulid() } }).expect(404);
    expect((await ta.get('/api/admin/notification-templates').expect(200)).body.targets.groups).toEqual([{ id: gid, name: 'Night shift' }]);
    // Everyone: the admin too; replace again changes nothing for those already on it.
    const all = (await apply({ mode: 'replace', target: { kind: 'everyone' } }).expect(200)).body;
    expect(all.people).toBeGreaterThanOrEqual(4);
    // Ana changed two kinds since, so replace puts two back.
    expect(all.changedKinds).toBeGreaterThanOrEqual(2);
    expect((await h.s.notificationPrefs.decide(h.tenantId, ana.id, 'feed', 'email')).deliver).toBe('suppressed');
    await apply({ mode: 'replace', target: { kind: 'users', usernames: ['nobody'] } }).expect(400);
    await apply({ mode: 'sometimes', target: { kind: 'everyone' } }).expect(400);

    const applied = await audits('notification.template.applied');
    expect(applied.map((e) => e.detail!.target).reverse()).toEqual(['users', 'users', 'users', 'role', 'group', 'everyone']);
    expect(applied.find((e) => e.detail!.target === 'role')!.detail).toMatchObject({ role: 'auditor', mode: 'replace', people: 1 });
    expect((await ta.get(`/api/admin/notification-templates/${tpl.id}`).expect(200)).body.people).toBeGreaterThanOrEqual(4);

    // Back to the defaults: no longer based on a template.
    const reset = (await ca.agent.delete('/api/me/notification-preferences').set('x-csrf-token', ca.csrf).expect(200)).body;
    expect(reset.template).toBeNull();
  });

  it('never turns off a kind the tenant made mandatory after the template was saved', async () => {
    await install(h);
    const ta = await admin();
    const ana = await localUser(h, 'ana', ['member']);
    const tpl = (await ta.post('/api/admin/notification-templates', { name: 'Calm', kinds: { flag: { in_app: OFF }, feed: { push: OFF } } }).expect(201)).body;
    await h.s.notificationPrefs.updateTenant(await principalOf(h, 'ta'), { kinds: { flag: { mandatory: true } } });
    const r = (await ta.post(`/api/admin/notification-templates/${tpl.id}/apply`, { mode: 'replace', target: { kind: 'users', userIds: [ana.id] } }).expect(200)).body;
    expect(r.skippedKinds).toEqual(['flag']);
    expect(await h.s.db('notification_pref_rules').where({ user_id: ana.id, kind: 'flag' })).toEqual([]);
    expect((await h.s.notificationPrefs.decide(h.tenantId, ana.id, 'flag', 'in_app')).deliver).toBe('now');
  });

  it('gives new members the tenant\'s default template, after their account commits', async () => {
    await install(h);
    const ta = await admin();
    const tpl = (await ta.post('/api/admin/notification-templates', { name: 'Starter', kinds: { feed: { email: OFF } }, digestHour: 6, defaultForNewMembers: true }).expect(201)).body;
    const dan = await localUser(h, 'dan', ['member']);
    await h.s.notificationPrefs.templates.settled();
    expect((await h.s.notificationPrefs.decide(h.tenantId, dan.id, 'feed', 'email')).deliver).toBe('suppressed');
    const c = await login(h, 'dan');
    const view = (await c.agent.get('/api/me/notification-preferences').expect(200)).body;
    expect(view).toMatchObject({ saved: true, digestHour: 6, template: { id: tpl.id, name: 'Starter', version: 1, mode: 'fill', changedKinds: 0 } });
    const a = (await audits('notification.template.applied')).find((e) => e.detail!.target === 'new-member')!;
    expect(a).toMatchObject({ kind: 'system', detail: { user: dan.id, name: 'Starter' } });

    // An account made in a transaction that rolls back gets nothing.
    await h.s.db.transaction(async (trx) => {
      await h.s.users.within(trx).create(h.tenantId, { username: 'ghost', displayName: 'Ghost' });
      throw new Error('roll back');
    }).catch(() => undefined);
    await h.s.notificationPrefs.templates.settled();
    expect((await audits('notification.template.applied')).filter((e) => e.detail!.target === 'new-member')).toHaveLength(1);

    // One made in a transaction that commits gets it once it has.
    let eve = '';
    await h.s.db.transaction(async (trx) => {
      eve = (await h.s.users.within(trx).create(h.tenantId, { username: 'eve', displayName: 'Eve' })).id;
    });
    await h.s.notificationPrefs.templates.settled();
    expect((await h.s.notificationPrefs.decide(h.tenantId, eve, 'feed', 'email')).deliver).toBe('suppressed');

    // No default: nothing.
    await ta.patch(`/api/admin/notification-templates/${tpl.id}`, { defaultForNewMembers: false }).expect(200);
    const fay = await localUser(h, 'fay', ['member']);
    await h.s.notificationPrefs.templates.settled();
    expect(await h.s.db('notification_pref_rules').where({ user_id: fay.id })).toEqual([]);
  });
});

/** A principal for calling the service directly as a signed-in user. */
async function principalOf(h: Harness, username: string) {
  const u = (await h.s.users.byUsername(h.tenantId, username))!;
  return { tenantId: h.tenantId, userId: u.id, username: u.username, displayName: u.display_name, sessionId: null, apiKeyId: null } as unknown as Parameters<Harness['s']['notificationPrefs']['updateTenant']>[0];
}
