import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { kindOf } from '../src/platform/notification-kinds.js';
import { decideWith, nextDigestAt, quietAt, type PersonPrefs, type TenantDefaults } from '../src/platform/notification-prefs.js';
import { FakeMail } from './fake-account.js';
import { harness, localUser, login, loginAdmin, type Harness } from './helpers.js';

/*
 * 1.9.0, Sprint 49 (B-153): notification preferences. The decision matrix; mandatory kinds; quiet hours in a time zone
 * across midnight and DST (the clock fixed through `at`); urgent passing through; digests collected and sent; and no
 * preferences meaning today's behaviour.
 */

const NONE: TenantDefaults = { kinds: new Map() };
const person = (o: Partial<PersonPrefs> = {}): PersonPrefs => ({ timeZone: null, quiet: {}, quietUrgent: true, digestHour: 8, digestWeekday: 0, rules: new Map(), saved: true, ...o });
const NY = 'America/New_York';

describe('notification decisions (pure)', () => {
  it('maps raw kinds to the catalogue', () => {
    expect(kindOf('security').id).toBe('security');
    expect(kindOf('group.member').id).toBe('group');
    expect(kindOf('platform.backup.failed').id).toBe('platform');
    expect(kindOf('security.scan.exception').id).toBe('security.scan');
    expect(kindOf('app.subscription.paused').id).toBe('app.subscription');
    expect(kindOf('something.new').id).toBe('other');
  });

  it('decides the matrix with no preferences: in-app and email now; push for people\'s own matters', () => {
    const p = person({ saved: false });
    for (const k of ['workflow', 'flag', 'platform.cert.failed', 'event.created']) {
      expect(decideWith(k, 'in_app', NONE, p).deliver).toBe('now');
      expect(decideWith(k, 'email', NONE, p).deliver).toBe('now');
    }
    expect(decideWith('message', 'push', NONE, p)).toMatchObject({ deliver: 'now', reason: 'instant' });
    expect(decideWith('event.created', 'websocket', NONE, p).deliver).toBe('now');
    expect(decideWith('flag', 'push', NONE, p)).toMatchObject({ deliver: 'suppressed', reason: 'off' });
    expect(decideWith('security', 'push', NONE, p)).toMatchObject({ deliver: 'now', reason: 'mandatory' });
  });

  it('applies a person\'s choice over the tenant default over the built-in one', () => {
    const tenant: TenantDefaults = { kinds: new Map([['workflow', { mandatory: false, channels: { email: { enabled: false, timing: 'instant' } } }]]) };
    expect(decideWith('workflow', 'email', tenant, person()).deliver).toBe('suppressed');
    const mine = person({ rules: new Map([['workflow', { email: { enabled: true, timing: 'daily' } }]]), timeZone: 'Asia/Tokyo' });
    const at = Date.UTC(2026, 5, 10, 0, 0); // Wednesday 09:00 in Tokyo
    expect(decideWith('workflow', 'email', tenant, mine, { at })).toEqual({ deliver: 'digest', reason: 'digest', kind: 'workflow', digest: { period: 'daily', dueAt: Date.UTC(2026, 5, 10, 23, 0) } });
    const off = person({ rules: new Map([['workflow', { in_app: { enabled: false, timing: 'instant' } }]]) });
    expect(decideWith('workflow', 'in_app', NONE, off)).toMatchObject({ deliver: 'suppressed', reason: 'off' });
  });

  it('never lets a mandatory kind be turned off or delayed', () => {
    const tryOff = person({ rules: new Map([['security', { in_app: { enabled: false, timing: 'instant' }, email: { enabled: true, timing: 'weekly' } }], ['workflow', { in_app: { enabled: false, timing: 'instant' } }]]), quiet: { mon: { start: '00:00', end: '23:59' } } });
    const at = Date.UTC(2026, 5, 15, 12); // a Monday, inside the quiet window
    expect(decideWith('security', 'in_app', NONE, tryOff, { at })).toMatchObject({ deliver: 'now', reason: 'mandatory' });
    expect(decideWith('security', 'email', NONE, tryOff, { at })).toMatchObject({ deliver: 'now', reason: 'mandatory' });
    const tenant: TenantDefaults = { kinds: new Map([['workflow', { mandatory: true, channels: {} }]]) };
    expect(decideWith('workflow', 'in_app', tenant, tryOff, { at })).toMatchObject({ deliver: 'now', reason: 'mandatory' });
    expect(decideWith('workflow', 'in_app', NONE, tryOff, { at }).deliver).toBe('suppressed');
  });

  it('keeps quiet hours in the person\'s time zone, across midnight and both DST changes', () => {
    const quiet = { sat: { start: '22:00', end: '07:00' } };
    // Spring forward (2026-03-08, a Sunday, 02:00 → 03:00): Saturday 23:30 EST is in the window, which ends Sunday 07:00 EDT.
    expect(quietAt(Date.UTC(2026, 2, 8, 4, 30), NY, quiet)).toEqual({ quiet: true, endsAt: Date.UTC(2026, 2, 8, 11, 0) });
    // Sunday 06:30 EDT: still Saturday's window, after midnight.
    expect(quietAt(Date.UTC(2026, 2, 8, 10, 30), NY, quiet)).toEqual({ quiet: true, endsAt: Date.UTC(2026, 2, 8, 11, 0) });
    expect(quietAt(Date.UTC(2026, 2, 8, 11, 0), NY, quiet).quiet).toBe(false);
    // Saturday 21:59 EST: not yet.
    expect(quietAt(Date.UTC(2026, 2, 8, 2, 59), NY, quiet).quiet).toBe(false);
    // Fall back (2026-11-01): Saturday 23:00 EDT; the window ends Sunday 07:00 EST.
    expect(quietAt(Date.UTC(2026, 10, 1, 3, 0), NY, quiet)).toEqual({ quiet: true, endsAt: Date.UTC(2026, 10, 1, 12, 0) });
    // Sunday 08:00 UTC is 03:00 EST, quiet in New York but not for a person without a zone (UTC).
    expect(quietAt(Date.UTC(2026, 10, 1, 8, 0), NY, quiet).quiet).toBe(true);
    expect(quietAt(Date.UTC(2026, 10, 1, 8, 0), 'UTC', quiet).quiet).toBe(false);
    // A daytime window on one weekday only.
    const lunch = { wed: { start: '12:00', end: '13:00' } };
    expect(quietAt(Date.UTC(2026, 5, 10, 10, 30), 'Europe/Berlin', lunch)).toEqual({ quiet: true, endsAt: Date.UTC(2026, 5, 10, 11, 0) });
    expect(quietAt(Date.UTC(2026, 5, 11, 10, 30), 'Europe/Berlin', lunch).quiet).toBe(false);
  });

  it('holds non-urgent push in quiet hours and lets urgent through when allowed; the inbox is never held by quiet hours', () => {
    const p = person({ timeZone: NY, quiet: { sat: { start: '22:00', end: '07:00' } } });
    const at = Date.UTC(2026, 2, 8, 4, 30);
    expect(decideWith('message', 'push', NONE, p, { at })).toEqual({ deliver: 'digest', reason: 'quiet_hours', kind: 'message', digest: { period: 'quiet', dueAt: Date.UTC(2026, 2, 8, 11, 0) } });
    expect(decideWith('message', 'push', NONE, p, { at, urgent: true })).toMatchObject({ deliver: 'now', reason: 'urgent' });
    expect(decideWith('message', 'push', NONE, { ...p, quietUrgent: false }, { at, urgent: true }).deliver).toBe('digest');
    expect(decideWith('message', 'email', NONE, p, { at }).deliver).toBe('digest');
    expect(decideWith('message', 'in_app', NONE, p, { at }).deliver).toBe('now');
  });

  it('computes digest times in the zone, and moves a digest past quiet hours', () => {
    expect(nextDigestAt('hourly', Date.UTC(2026, 5, 10, 10, 20), 'Asia/Kolkata', 8, 0)).toBe(Date.UTC(2026, 5, 10, 10, 30));
    expect(nextDigestAt('weekly', Date.UTC(2026, 5, 10, 0, 0), 'Asia/Tokyo', 8, 0)).toBe(Date.UTC(2026, 5, 14, 23, 0));
    expect(nextDigestAt('daily', Date.UTC(2026, 2, 7, 15, 0), NY, 8, 0)).toBe(Date.UTC(2026, 2, 8, 12, 0)); // 08:00 EDT, after the change
    const p = person({ timeZone: NY, digestHour: 8, quiet: { sun: { start: '06:00', end: '09:30' } }, rules: new Map([['feed', { email: { enabled: true, timing: 'daily' } }]]) });
    expect(decideWith('feed', 'email', NONE, p, { at: Date.UTC(2026, 2, 7, 15, 0) }).digest).toEqual({ period: 'daily', dueAt: Date.UTC(2026, 2, 8, 13, 30) });
  });
});

describe('notification preferences (Sprint 49, B-153)', () => {
  let h: Harness;
  let mail: FakeMail;
  beforeEach(async () => {
    mail = new FakeMail();
    h = await harness({ SMTP_URL: 'smtp://localhost:2525' }, { mail });
  });
  afterEach(async () => {
    await h.close();
  });

  const audits = async (prefix: string) => ((await h.s.audit.list(h.tenantId, { limit: 200 })) as { action: string; detail: Record<string, unknown> | null }[]).filter((e) => e.action.startsWith(prefix));
  const flush = () => new Promise((r) => setTimeout(r, 50));

  it('changes nothing without preferences: in-app now and the email the sender asked for', async () => {
    const u = await localUser(h, 'ana', ['member']);
    await h.s.db('users').where({ id: u.id }).update({ email: 'ana@example.test' });
    const rows = await h.s.notifications.notify({ tenantId: h.tenantId, userIds: [u.id], kind: 'workflow', title: 'Approve the invoice', route: 'workflows', email: true });
    expect(rows).toHaveLength(1);
    expect(await h.s.db('notifications').where({ user_id: u.id })).toHaveLength(1);
    await flush();
    expect(mail.to('ana@example.test')).toHaveLength(1);
    expect(await h.s.db('notification_digest_items')).toEqual([]);
  });

  it('reads and saves a person\'s preferences; refuses to turn a mandatory kind off; resets', async () => {
    await localUser(h, 'ana', ['member']);
    const c = await login(h, 'ana');
    const put = (b: object) => c.agent.put('/api/me/notification-preferences').set('x-csrf-token', c.csrf).send(b);
    const view = (await c.agent.get('/api/me/notification-preferences').expect(200)).body;
    expect(view).toMatchObject({ saved: false, timeZone: null, channels: ['in_app', 'email', 'push', 'websocket'] });
    const sec = view.kinds.find((k: { id: string }) => k.id === 'security');
    expect(sec).toMatchObject({ mandatory: true, lockedBy: 'platform' });
    expect(sec.lockedReason).toMatch(/Nobody can turn them off/);

    const r = (await put({ timeZone: NY, quietHours: { sat: { start: '22:00', end: '07:00' } }, kinds: { workflow: { email: { enabled: true, timing: 'daily' }, push: { enabled: false, timing: 'instant' } } } }).expect(200)).body;
    expect(r).toMatchObject({ saved: true, timeZone: NY, quietHours: { sat: { start: '22:00', end: '07:00' }, sun: null } });
    expect(r.kinds.find((k: { id: string }) => k.id === 'workflow').channels).toMatchObject({ email: { enabled: true, timing: 'daily', source: 'you' }, push: { enabled: false, source: 'you' }, in_app: { enabled: true, source: 'default' } });

    const refused = await put({ kinds: { security: { in_app: { enabled: false, timing: 'instant' } } } }).expect(409);
    expect(refused.body.kinds).toEqual(['security']);
    expect(refused.headers['content-type']).toMatch(/problem\+json/);
    await put({ kinds: { 'no-such-kind': { in_app: { enabled: false, timing: 'instant' } } } }).expect(400);
    await put({ timeZone: 'Mars/Olympus' }).expect(400);
    await put({ quietHours: { mon: { start: '22:00', end: '22:00' } } }).expect(400);

    // Back to one channel following the default.
    const cleared = (await put({ kinds: { workflow: { push: null } } }).expect(200)).body;
    expect(cleared.kinds.find((k: { id: string }) => k.id === 'workflow').channels.push.source).toBe('default');

    const reset = (await c.agent.delete('/api/me/notification-preferences').set('x-csrf-token', c.csrf).expect(200)).body;
    expect(reset).toMatchObject({ saved: false, timeZone: null });
    expect((await audits('notification.prefs.')).map((e) => e.action).sort()).toEqual(['notification.prefs.reset', 'notification.prefs.updated', 'notification.prefs.updated']);
  });

  it('lets a tenant admin set defaults and mark kinds mandatory, never making security alerts optional', async () => {
    const ana = await localUser(h, 'ana', ['member']);
    await localUser(h, 'ta', ['tenant-admin'], 'confidential');
    const admin = await loginAdmin(h, 'ta');
    const c = await login(h, 'ana');
    await c.agent.get('/api/admin/notification-defaults').expect(403);
    const putDefaults = (b: object) => admin.agent.put('/api/admin/notification-defaults').set('x-csrf-token', admin.csrf).send(b);

    // Ana turns workflow in-app off first.
    await c.agent.put('/api/me/notification-preferences').set('x-csrf-token', c.csrf).send({ kinds: { workflow: { in_app: { enabled: false, timing: 'instant' } } } }).expect(200);
    expect((await h.s.notificationPrefs.decide(h.tenantId, ana.id, 'workflow', 'in_app')).deliver).toBe('suppressed');

    const d = (await putDefaults({ kinds: { workflow: { mandatory: true }, feed: { channels: { email: { enabled: false, timing: 'instant' } } } } }).expect(200)).body;
    expect(d.kinds.find((k: { id: string }) => k.id === 'workflow')).toMatchObject({ mandatory: true, locked: false });
    expect(d.kinds.find((k: { id: string }) => k.id === 'feed').channels.email).toMatchObject({ enabled: false, source: 'tenant' });
    // The change reaches decisions at once (the cache is dropped), and Ana's own "off" no longer applies.
    expect(await h.s.notificationPrefs.decide(h.tenantId, ana.id, 'workflow', 'in_app')).toMatchObject({ deliver: 'now', reason: 'mandatory' });
    expect((await h.s.notificationPrefs.decide(h.tenantId, ana.id, 'feed', 'email')).deliver).toBe('suppressed');
    const mine = (await c.agent.get('/api/me/notification-preferences').expect(200)).body.kinds.find((k: { id: string }) => k.id === 'workflow');
    expect(mine).toMatchObject({ mandatory: true, lockedBy: 'tenant' });
    expect(mine.lockedReason).toMatch(/organisation made this kind mandatory/);
    await c.agent.put('/api/me/notification-preferences').set('x-csrf-token', c.csrf).send({ kinds: { workflow: { email: { enabled: true, timing: 'weekly' } } } }).expect(409);

    await putDefaults({ kinds: { security: { mandatory: false } } }).expect(409);
    await putDefaults({ kinds: { security: null } }).expect(409);
    await putDefaults({ kinds: { workflow: null } }).expect(200);
    expect((await h.s.notificationPrefs.decide(h.tenantId, ana.id, 'workflow', 'in_app')).deliver).toBe('suppressed');
    expect((await audits('notification.defaults.')).length).toBe(2);
  });

  it('collects digest items and sends them at the period through the inbox and email', async () => {
    const u = await localUser(h, 'ana', ['member']);
    await h.s.db('users').where({ id: u.id }).update({ email: 'ana@example.test' });
    const c = await login(h, 'ana');
    await c.agent.put('/api/me/notification-preferences').set('x-csrf-token', c.csrf).send({ timeZone: 'UTC', digestHour: 8, kinds: { workflow: { in_app: { enabled: true, timing: 'daily' }, email: { enabled: true, timing: 'daily' } } } }).expect(200);
    const published: unknown[] = [];
    h.s.bus.on('notification', (e) => void published.push(e));

    const rows = await h.s.notifications.notify({ tenantId: h.tenantId, userIds: [u.id], kind: 'workflow', title: 'Approve invoice 42', route: 'workflows', email: true });
    await h.s.notifications.notify({ tenantId: h.tenantId, userIds: [u.id], kind: 'workflow.step', title: 'Weekly report ready', label: 'confidential', email: true });
    // Security alerts are never held.
    await h.s.notifications.notify({ tenantId: h.tenantId, userIds: [u.id], kind: 'security', title: 'Your password was changed' });
    await flush();
    expect(rows).toEqual([]);
    expect((await h.s.db('notifications').where({ user_id: u.id })).map((r: { kind: string }) => r.kind)).toEqual(['security']);
    expect(mail.to('ana@example.test')).toHaveLength(0);
    const items = (await h.s.db('notification_digest_items').where({ user_id: u.id })) as { channel: string; title_sealed: string; due_at: number }[];
    expect(items.map((i) => i.channel).sort()).toEqual(['email', 'email', 'in_app', 'in_app']);
    expect(JSON.stringify(items)).not.toContain('Approve invoice 42');

    // Nothing is due yet.
    expect((await h.s.notificationPrefs.sendDue(h.tenantId)).items).toBe(0);
    const due = Math.max(...items.map((i) => Number(i.due_at)));
    const sent = await h.s.notificationPrefs.sendDue(h.tenantId, due + 1);
    expect(sent).toEqual({ people: 1, items: 4, emails: 1 });
    await flush();
    const inbox = (await h.s.db('notifications').where({ user_id: u.id, kind: 'notification.digest' })) as { title: string; body: string; label: string }[];
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ title: '2 notifications held for you', label: 'confidential' });
    expect(inbox[0]!.body).toContain('Approve invoice 42');
    const email = mail.to('ana@example.test');
    expect(email).toHaveLength(1);
    expect(email[0]!.subject).toBe('2 notifications from Exprsn-AI');
    expect(email[0]!.text).toContain('Approve invoice 42');
    // A confidential title is not emailed.
    expect(email[0]!.text).not.toContain('Weekly report ready');
    expect(email[0]!.text).toContain('a notification labelled confidential');
    // Sent once.
    expect((await h.s.notificationPrefs.sendDue(h.tenantId, due + 2)).items).toBe(0);
    expect(published.length).toBeGreaterThanOrEqual(2);
  });

  it('holds push for quiet hours through collect, for delivery to send at the end of the window', async () => {
    const u = await localUser(h, 'ana', ['member']);
    const c = await login(h, 'ana');
    await c.agent.put('/api/me/notification-preferences').set('x-csrf-token', c.csrf).send({ timeZone: NY, quietHours: { sat: { start: '22:00', end: '07:00' } }, urgentPassesQuiet: true }).expect(200);
    const at = Date.UTC(2026, 2, 8, 4, 30);
    const d = await h.s.notificationPrefs.decide(h.tenantId, u.id, 'message', 'push', { at });
    expect(d).toMatchObject({ deliver: 'digest', reason: 'quiet_hours', digest: { dueAt: Date.UTC(2026, 2, 8, 11, 0) } });
    expect(await h.s.notificationPrefs.collect({ tenantId: h.tenantId, userId: u.id, kind: 'message', channel: 'push', title: 'New message from Ben' }, d)).toBeTruthy();
    expect(await h.s.notificationPrefs.collect({ tenantId: h.tenantId, userId: u.id, kind: 'message', channel: 'push', title: 'x' }, { deliver: 'now', reason: 'instant', kind: 'message' })).toBeNull();
    expect((await h.s.notificationPrefs.decide(h.tenantId, u.id, 'message', 'push', { at, urgent: true })).deliver).toBe('now');
    const sent = await h.s.notificationPrefs.sendDue(h.tenantId, Date.UTC(2026, 2, 8, 11, 0));
    expect(sent.items).toBe(1);
    expect(await h.s.db('notifications').where({ user_id: u.id, kind: 'notification.digest' })).toHaveLength(1);
  });
});
