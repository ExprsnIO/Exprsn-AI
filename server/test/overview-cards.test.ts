import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CARD_IDS } from '../src/ops/overview-cards.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';

/*
 * 1.8.0, Sprint 48 (B-148): the Overview's cards, per admin. Each admin pins, hides, reorders and resets their own
 * cards and picks a density; nobody is shown, or may save, a card whose permission they lack.
 */

type Layout = { cards: { id: string; pinned: boolean; hidden: boolean; optional: boolean }[]; density: string; saved: boolean; visible: string[] };
type Admin = Client & { send: (m: 'put' | 'delete', p: string, b?: object) => ReturnType<Client['agent']['put']> };

describe('Overview cards (Sprint 48, B-148)', () => {
  let h: Harness;
  const admin = async (name: string, roles: string[]): Promise<Admin> => {
    await localUser(h, name, roles, 'confidential');
    const c = await loginAdmin(h, name);
    return { ...c, send: (m, p, b = {}) => c.agent[m](p).set('x-csrf-token', c.csrf).send(b) };
  };

  beforeEach(async () => {
    h = await harness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('keeps each admin\'s layout apart: pin, hide, reorder, density and reset', async () => {
    const ta = await admin('ta', ['tenant-admin']);
    const tb = await admin('tb', ['tenant-admin']);
    const first = (await ta.agent.get('/api/admin/overview-cards').expect(200)).body as Layout;
    expect(first.saved).toBe(false);
    expect(first.density).toBe('comfortable');
    // Optional cards start hidden; the built-in ones are shown in the catalogue order.
    expect(first.cards.filter((c) => c.optional).every((c) => c.hidden)).toBe(true);
    expect(first.visible.slice(0, 2)).toEqual(['alerts', 'counters']);

    const ids = first.cards.map((c) => c.id);
    const order = [...ids].reverse();
    const saved = (await ta.send('put', '/api/admin/overview-cards', { order, pinned: ['audit'], hidden: ['schedules'], density: 'compact' }).expect(200)).body as Layout;
    expect(saved.density).toBe('compact');
    expect(saved.cards[0]).toMatchObject({ id: 'audit', pinned: true });
    expect(saved.cards.map((c) => c.id).slice(1)).toEqual(order.filter((id) => id !== 'audit'));
    expect(saved.visible).not.toContain('schedules');
    expect(saved.cards.find((c) => c.id === 'schedules')!.hidden).toBe(true);
    // A pinned optional card is shown once it is not hidden.
    const optional = saved.cards.find((c) => c.optional);
    if (optional) {
      const withOptional = (await ta.send('put', '/api/admin/overview-cards', { order, pinned: ['audit', optional.id], hidden: ['schedules'], density: 'compact' }).expect(200)).body as Layout;
      expect(withOptional.visible.slice(0, 2).sort()).toEqual(['audit', optional.id].sort());
      expect(withOptional.cards.filter((c) => c.pinned).map((c) => c.id)).toEqual(order.filter((id) => id === 'audit' || id === optional.id));
    }

    // The other admin still has the default layout.
    const other = (await tb.agent.get('/api/admin/overview-cards').expect(200)).body as Layout;
    expect(other).toMatchObject({ saved: false, density: 'comfortable' });
    expect(other.cards.map((c) => c.id)).toEqual(ids);

    // Unknown ids and repeated ones are refused.
    await ta.send('put', '/api/admin/overview-cards', { order: ['alerts', 'nope'] }).expect(400);
    await ta.send('put', '/api/admin/overview-cards', { order: ['alerts', 'alerts'] }).expect(400);
    await ta.send('put', '/api/admin/overview-cards', { order: ['alerts'], extra: 1 }).expect(400);

    const reset = (await ta.send('delete', '/api/admin/overview-cards').expect(200)).body as Layout;
    expect(reset).toMatchObject({ saved: false, density: 'comfortable' });
    expect(reset.cards.map((c) => c.id)).toEqual(ids);
    const audit = ((await h.s.audit.list(h.tenantId, { limit: 50 })) as { action: string; actor: { user?: string } }[]).filter((e) => e.action.startsWith('overview.cards.'));
    expect(audit.map((e) => e.action).sort()).toEqual(['overview.cards.reset', 'overview.cards.updated', ...(optional ? ['overview.cards.updated'] : [])].sort());
  });

  it('never shows, computes or saves a card the admin lacks the permission for', async () => {
    const ta = await admin('ta', ['tenant-admin']);
    const sys = await admin('root2', ['system-admin']);
    const tenantCards = ((await ta.agent.get('/api/admin/overview-cards').expect(200)).body as Layout).cards.map((c) => c.id);
    // A tenant admin: no platform cards, no running workflows (workflows:manage), no revisions (knowledge:read).
    for (const id of ['instances', 'capacity', 'workflows-running', 'revisions-waiting']) expect(tenantCards).not.toContain(id);
    expect(tenantCards).toEqual(expect.arrayContaining(['alerts', 'counters', 'schedules', 'audit', 'plugins', 'approvals-pending']));
    const sysCards = ((await sys.agent.get('/api/admin/overview-cards').expect(200)).body as Layout).cards.map((c) => c.id);
    expect(sysCards).toEqual(expect.arrayContaining(['instances', 'capacity', 'workflows-running', 'revisions-waiting', 'approvals-pending']));
    expect(CARD_IDS).toEqual(expect.arrayContaining(sysCards));

    // Saving one it may not see is refused, and nothing is stored.
    const refused = await ta.send('put', '/api/admin/overview-cards', { order: ['alerts', 'instances'] }).expect(403);
    expect(refused.body.cards).toEqual(['instances']);
    await ta.send('put', '/api/admin/overview-cards', { order: ['alerts'], pinned: ['workflows-running'] }).expect(403);
    expect(((await ta.agent.get('/api/admin/overview-cards').expect(200)).body as Layout).saved).toBe(false);

    // The optional cards' figures: only those the admin may see are computed.
    const taData = (await ta.agent.get('/api/admin/overview-cards/data?cards=workflows-running,revisions-waiting,approvals-pending').expect(200)).body as Record<string, unknown>;
    expect(Object.keys(taData)).toEqual(['approvals-pending']);
    expect(taData['approvals-pending']).toMatchObject({ count: 0 });
    const sysData = (await sys.agent.get('/api/admin/overview-cards/data?cards=workflows-running,revisions-waiting,alerts').expect(200)).body as Record<string, unknown>;
    expect(sysData['workflows-running']).toMatchObject({ running: 0, waiting: 0, items: [] });
    expect(sysData['revisions-waiting']).toMatchObject({ count: 0 });
    expect(sysData.alerts).toBeUndefined();

    // A layout saved while a card was allowed keeps it stored but stops showing it once the permission goes.
    const tw = await admin('tw', ['tenant-admin', 'workflow-admin']);
    const twCards = ((await tw.agent.get('/api/admin/overview-cards').expect(200)).body as Layout).cards.map((c) => c.id);
    expect(twCards).toContain('workflows-running');
    await tw.send('put', '/api/admin/overview-cards', { order: twCards, pinned: ['workflows-running'], hidden: [] }).expect(200);
    const twUser = (await h.s.db('users').where({ tenant_id: h.tenantId, username: 'tw' }).first('id')) as { id: string };
    await h.s.users.setRoles(twUser.id, 'direct', ['tenant-admin']);
    const after = (await tw.agent.get('/api/admin/overview-cards').expect(200)).body as Layout;
    expect(after.cards.map((c) => c.id)).not.toContain('workflows-running');
    expect(after.saved).toBe(true);

    // Someone who is not an admin does not reach the cards at all.
    await localUser(h, 'mem', ['member'], 'internal');
    const member = await login(h, 'mem');
    await member.agent.get('/api/admin/overview-cards').expect(403);
  });
});
