import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { audits, club, expire, personIn, world, type World } from './group-governance-helpers.js';

/*
 * 1.9.0, Sprint 53 (B-174): group proposals. Each kind is drafted and validated, the states run draft → open →
 * closed → carried out (or failed), the governance settings decide who may propose, the discussion is linked in the
 * group's conversation, and the proposal's text is sealed at rest with the group's label.
 */

describe('group proposals (B-174)', () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  }, 120_000);
  afterEach(async () => {
    await w.h.close();
  });

  it('drafts each kind, checking what the action names', async () => {
    const { alice, bob, carol, erin } = w;
    const g = await club(w, [bob, carol]);
    const base = `/api/groups/${g.id}/proposals`;
    // free-form, yes or no; and free-form between options
    const free = (await bob.post(base, { kind: 'free', title: 'Meet on Thursdays', body: 'Thursday evenings suit most of us.' }).expect(201)).body;
    expect(free).toMatchObject({ kind: 'free', state: 'draft', method: 'majority', title: 'Meet on Thursdays', options: [] });
    const pick = (await bob.post(base, { kind: 'free', title: 'Which seeds', method: 'approval', options: ['Tomatoes', 'Beans', 'Kale'] }).expect(201)).body;
    expect(pick.options).toEqual([{ id: 'o1', label: 'Tomatoes' }, { id: 'o2', label: 'Beans' }, { id: 'o3', label: 'Kale' }]);
    expect((await bob.post(base, { kind: 'free', title: 'One option', method: 'ranked', options: ['Only'] }).expect(422)).body.step).toBe('options');
    // a change is decided yes or no
    expect((await bob.post(base, { kind: 'setting', title: 'Rename', method: 'approval', options: ['a', 'b'], action: { patch: { name: 'x' } } }).expect(422)).body.step).toBe('method');
    // change a setting
    const setting = (await bob.post(base, { kind: 'setting', title: 'Rename the club', action: { patch: { name: 'Allotment club', joinMode: 'request' } } }).expect(201)).body;
    expect(setting.action).toMatchObject({ patch: { name: 'Allotment club', joinMode: 'request' } });
    expect((await bob.post(base, { kind: 'setting', title: 'Nothing', action: { patch: {} } }).expect(422)).body.step).toBe('action');
    expect((await bob.post(base, { kind: 'setting', title: 'The label', action: { patch: { label: 'restricted' } } }).expect(422)).body.step).toBe('action');
    // add or remove a member
    const add = (await bob.post(base, { kind: 'member', title: 'Invite Erin', action: { op: 'add', userId: erin.user.id } }).expect(201)).body;
    expect(add.action).toMatchObject({ op: 'add', userId: erin.user.id, userName: 'ERIN' });
    expect((await bob.post(base, { kind: 'member', title: 'Add Carol', action: { op: 'add', userId: carol.user.id } }).expect(422)).body.title).toBe('Already a member');
    expect((await bob.post(base, { kind: 'member', title: 'Remove Erin', action: { op: 'remove', userId: erin.user.id } }).expect(422)).body.title).toBe('Not a member');
    await bob.post(base, { kind: 'member', title: 'Remove Carol', action: { op: 'remove', userId: carol.user.id } }).expect(201);
    // give or take a role
    await bob.post(base, { kind: 'role', title: 'Carol moderates', action: { userId: carol.user.id, role: 'moderator' } }).expect(201);
    expect((await bob.post(base, { kind: 'role', title: 'Erin moderates', action: { userId: erin.user.id, role: 'moderator' } }).expect(422)).body.title).toBe('Not a member');
    expect((await bob.post(base, { kind: 'role', title: 'No role', action: { userId: carol.user.id } }).expect(422)).body.step).toBe('action');
    // change the rules
    await bob.post(base, { kind: 'rules', title: 'Our rules', action: { rules: 'Water your plot weekly.' } }).expect(201);
    // spend from the budget: needs a budget first
    expect((await bob.post(base, { kind: 'spend', title: 'Buy a hose', action: { amountMinor: 2500, memo: 'A hose' } }).expect(422)).body.step).toBe('budget');
    await bob.put(`/api/groups/${g.id}/budget`, { currency: 'eur' }).expect(403);
    expect((await alice.put(`/api/groups/${g.id}/budget`, { currency: 'eur' }).expect(200)).body).toMatchObject({ currency: 'EUR', balanceMinor: 0 });
    const spend = (await bob.post(base, { kind: 'spend', title: 'Buy a hose', action: { amountMinor: 2500, memo: 'A hose' } }).expect(201)).body;
    expect(spend.action).toEqual({ amountMinor: 2500, memo: 'A hose' });
    await bob.post(base, { kind: 'nonsense', title: 'x' }).expect(400);

    // drafts are their author's (and the owners')
    const listed = (await carol.get(base).expect(200)).body;
    expect(listed.proposals).toHaveLength(0);
    expect((await alice.get(base).expect(200)).body.proposals.length).toBeGreaterThan(5);
    await carol.get(`/api/group-proposals/${free.id}`).expect(404);
    expect((await audits(w.h, 'group.proposal.created')).length).toBeGreaterThan(7);
    void pick;
  });

  it('runs draft → open → closed → carried out, and keeps a failure on the record', async () => {
    const { h, alice, bob, carol, erin } = w;
    const g = await club(w, [bob, carol]);
    const pr = (await bob.post(`/api/groups/${g.id}/proposals`, { kind: 'free', title: 'Draft one' }).expect(201)).body;
    // only the author changes a draft
    await carol.patch(`/api/group-proposals/${pr.id}`, { title: 'Mine now' }).expect(404);
    await alice.patch(`/api/group-proposals/${pr.id}`, { title: 'Owner edit' }).expect(403);
    expect((await bob.patch(`/api/group-proposals/${pr.id}`, { title: 'Draft, edited', body: 'Now with text' }).expect(200)).body).toMatchObject({ title: 'Draft, edited', body: 'Now with text', state: 'draft' });
    // voting time within the group's range
    expect((await bob.post(`/api/group-proposals/${pr.id}/open`, { hours: 2 }).expect(422)).body.step).toBe('hours');
    const opened = (await bob.post(`/api/group-proposals/${pr.id}/open`, { hours: 48 }).expect(200)).body;
    expect(opened).toMatchObject({ state: 'open', electorate: 3, hours: 48, can: { vote: true, edit: false } });
    expect(opened.closesAt - opened.opensAt).toBe(48 * 3_600_000);
    await bob.patch(`/api/group-proposals/${pr.id}`, { title: 'Too late' }).expect(409);
    await bob.del(`/api/group-proposals/${pr.id}`).expect(409);
    await bob.post(`/api/group-proposals/${pr.id}/open`).expect(409);
    // a draft can be deleted
    const gone = (await bob.post(`/api/groups/${g.id}/proposals`, { kind: 'free', title: 'Never mind' }).expect(201)).body;
    await bob.del(`/api/group-proposals/${gone.id}`).expect(200);
    await bob.get(`/api/group-proposals/${gone.id}`).expect(404);

    for (const x of [alice, bob]) await x.post(`/api/group-proposals/${pr.id}/ballots`, { choice: 'yes' }).expect(200);
    await expire(h, pr.id);
    const closed = (await carol.get(`/api/group-proposals/${pr.id}`).expect(200)).body;
    expect(closed).toMatchObject({ state: 'closed', outcome: 'passed', turnout: 2 });

    // an actionable kind is carried out; one that cannot be ends as failed with the reason
    const role = (await bob.post(`/api/groups/${g.id}/proposals`, { kind: 'role', title: 'Carol moderates', action: { userId: carol.user.id, role: 'moderator' } }).expect(201)).body;
    await bob.post(`/api/group-proposals/${role.id}/open`).expect(200);
    for (const x of [alice, bob]) await x.post(`/api/group-proposals/${role.id}/ballots`, { choice: 'yes' }).expect(200);
    await expire(h, role.id);
    expect((await bob.get(`/api/group-proposals/${role.id}`).expect(200)).body).toMatchObject({ state: 'carried_out', outcome: 'passed', carriedResult: { userId: carol.user.id, role: 'moderator' } });
    expect((await h.s.db('group_members').where({ group_id: g.id, user_id: carol.user.id }).first()).role).toBe('moderator');

    const rm = (await bob.post(`/api/groups/${g.id}/proposals`, { kind: 'member', title: 'Remove Carol', action: { op: 'remove', userId: carol.user.id } }).expect(201)).body;
    await bob.post(`/api/group-proposals/${rm.id}/open`).expect(200);
    for (const x of [alice, bob]) await x.post(`/api/group-proposals/${rm.id}/ballots`, { choice: 'yes' }).expect(200);
    await carol.del(`/api/groups/${g.id}/members/${carol.user.id}`).expect(200);
    await expire(h, rm.id);
    const failed = (await bob.get(`/api/group-proposals/${rm.id}`).expect(200)).body;
    expect(failed.state).toBe('failed');
    expect(failed.failure).toMatch(/Member not found/);
    // a rejected one stays closed
    const no = (await bob.post(`/api/groups/${g.id}/proposals`, { kind: 'setting', title: 'Hide it', action: { patch: { visibility: 'hidden' } } }).expect(201)).body;
    await bob.post(`/api/group-proposals/${no.id}/open`).expect(200);
    await alice.post(`/api/group-proposals/${no.id}/ballots`, { choice: 'no' }).expect(200);
    await expire(h, no.id);
    expect((await bob.get(`/api/group-proposals/${no.id}`).expect(200)).body).toMatchObject({ state: 'closed', outcome: 'rejected', carriedAt: null });
    expect((await h.s.db('social_groups').where({ id: g.id }).first()).visibility).toBe('public');
    for (const a of ['group.proposal.created', 'group.proposal.updated', 'group.proposal.deleted', 'group.proposal.opened', 'group.proposal.closed', 'group.decision.applied', 'group.decision.failed']) expect((await audits(h, a)).length, a).toBeGreaterThan(0);
    void erin;
  });

  it('governance settings decide who may propose, and only owners and admins change them', async () => {
    const { alice, bob, carol, dave } = w;
    const g = await club(w, [bob, carol, dave]);
    const base = `/api/groups/${g.id}/proposals`;
    const view = (await bob.get(`/api/groups/${g.id}/governance`).expect(200)).body;
    expect(view).toMatchObject({ available: true, propose: 'members', method: 'majority', quorum: { kind: 'none', value: 0 }, minHours: 24, maxHours: 336, defaultHours: 72, canPropose: true, canManage: false, canConfirm: false });
    await bob.put(`/api/groups/${g.id}/governance`, { propose: 'owners' }).expect(403);
    // owners only
    expect((await alice.put(`/api/groups/${g.id}/governance`, { propose: 'owners' }).expect(200)).body).toMatchObject({ propose: 'owners', canPropose: true, canManage: true, canConfirm: true });
    expect((await bob.post(base, { kind: 'free', title: 'Mine' }).expect(403)).body.step).toBe('governance');
    expect((await bob.get(`/api/groups/${g.id}/governance`).expect(200)).body.canPropose).toBe(false);
    await alice.post(base, { kind: 'free', title: 'The owner proposes' }).expect(201);
    // a role, or more: moderators and above
    await alice.patch(`/api/groups/${g.id}/members/${carol.user.id}`, { role: 'moderator' }).expect(200);
    await alice.put(`/api/groups/${g.id}/governance`, { propose: 'role' }).expect(422);
    await alice.put(`/api/groups/${g.id}/governance`, { propose: 'role', proposeRole: 'moderator' }).expect(200);
    await carol.post(base, { kind: 'free', title: 'A moderator proposes' }).expect(201);
    await bob.post(base, { kind: 'free', title: 'A member does not' }).expect(403);
    // a custom role
    const role = (await alice.post(`/api/groups/${g.id}/roles`, { name: 'Treasurer', rights: ['post', 'rsvp'] }).expect(201)).body;
    await alice.patch(`/api/groups/${g.id}/members/${dave.user.id}`, { customRoleId: role.id }).expect(200);
    await alice.put(`/api/groups/${g.id}/governance`, { propose: 'role', proposeRole: role.id }).expect(200);
    await dave.post(base, { kind: 'free', title: 'The treasurer proposes' }).expect(201);
    // back to members; the voting range and supermajority are checked
    await alice.put(`/api/groups/${g.id}/governance`, { propose: 'members' }).expect(200);
    await bob.post(base, { kind: 'free', title: 'Everyone again' }).expect(201);
    expect((await alice.put(`/api/groups/${g.id}/governance`, { minHours: 100, maxHours: 50 }).expect(422)).body.step).toBe('hours');
    expect((await alice.put(`/api/groups/${g.id}/governance`, { threshold: { num: 1, den: 2 } }).expect(422)).body.step).toBe('threshold');
    const after = (await alice.put(`/api/groups/${g.id}/governance`, { method: 'supermajority', threshold: { num: 3, den: 5 }, quorum: { kind: 'share', value: 50 }, minHours: 1, maxHours: 24, defaultHours: 12, secret: true, confirmKinds: ['spend', 'member'], rules: 'Be kind.' }).expect(200)).body;
    expect(after).toMatchObject({ method: 'supermajority', threshold: { num: 3, den: 5 }, quorum: { kind: 'share', value: 50 }, defaultHours: 12, secret: true, confirmKinds: ['spend', 'member'], rules: 'Be kind.' });
    // the defaults reach a new proposal
    const pr = (await bob.post(base, { kind: 'free', title: 'Defaults' }).expect(201)).body;
    expect(pr).toMatchObject({ method: 'supermajority', threshold: { num: 3, den: 5 }, quorum: { kind: 'share', value: 50 }, secret: true });
    const changed = (await audits(w.h, 'group.governance.updated')).at(-1)!;
    expect(changed.detail).toMatchObject({ rulesChanged: true });
    expect(JSON.stringify(changed.detail)).not.toContain('Be kind');
    // a guest neither proposes nor votes
    await alice.patch(`/api/groups/${g.id}/members/${bob.user.id}`, { role: 'guest' }).expect(200);
    await bob.post(base, { kind: 'free', title: 'As a guest' }).expect(403);
  });

  it('links the discussion in the group’s conversation and posts the result there', async () => {
    const { h, alice, bob, carol } = w;
    const g = await club(w, [bob, carol]);
    // without a linked conversation there is no discussion post
    const quiet = (await bob.post(`/api/groups/${g.id}/proposals`, { kind: 'free', title: 'No conversation yet' }).expect(201)).body;
    expect((await bob.post(`/api/group-proposals/${quiet.id}/open`).expect(200)).body.discussion).toBeNull();
    const conv = (await alice.put(`/api/groups/${g.id}/conversation`, {}).expect(201)).body;
    expect(conv.linked).toBe(true);
    const pr = (await bob.post(`/api/groups/${g.id}/proposals`, { kind: 'free', title: 'Compost bins' }).expect(201)).body;
    const opened = (await bob.post(`/api/group-proposals/${pr.id}/open`).expect(200)).body;
    expect(opened.discussion).toMatchObject({ conversationId: conv.conversationId, messageId: expect.any(String) });
    const msg = await h.s.db('dm_messages').where({ id: opened.discussion.messageId }).first();
    expect(msg).toMatchObject({ conversation_id: conv.conversationId, author_id: bob.user.id });
    expect(await h.s.keys.open(h.tenantId, msg.body, `dm-message:${msg.id}`)).toContain('Compost bins');
    // members read it in the conversation
    const list = (await carol.get(`/api/messaging/conversations/${conv.conversationId}/messages`).expect(200)).body;
    const items = (Array.isArray(list) ? list : (list.items ?? list.messages)) as { id: string; body: string }[];
    expect(items.find((m) => m.id === msg.id)?.body).toContain('Compost bins');
    await alice.post(`/api/group-proposals/${pr.id}/ballots`, { choice: 'yes' }).expect(200);
    await expire(h, pr.id);
    await bob.get(`/api/group-proposals/${pr.id}`).expect(200);
    const replies = (await h.s.db('dm_messages').where({ conversation_id: conv.conversationId, thread_id: msg.id })) as { id: string; body: string; author_id: string }[];
    expect(replies).toHaveLength(1);
    expect(replies[0]!.author_id).toBe(g.id);
    expect(await h.s.keys.open(h.tenantId, replies[0]!.body, `dm-message:${replies[0]!.id}`)).toMatch(/The vote on “Compost bins” closed: passed/);
  });

  it('seals the proposal’s text with the group’s label', async () => {
    const { h } = w;
    const conf = (await h.s.tenants.createWorkspace(h.tenantId, 'Board', 'confidential')).id;
    const gina = await personIn(h, 'gina', [conf], ['member'], 'confidential');
    const hank = await personIn(h, 'hank', [conf], ['member'], 'confidential');
    const board = (await gina.post('/api/groups', { workspaceId: conf, name: 'Board', joinMode: 'open', visibility: 'public', label: 'confidential' }).expect(201)).body;
    await hank.post(`/api/groups/${board.id}/join`).expect(200);
    const secret = 'Sell the north field to the neighbours';
    const pr = (await hank.post(`/api/groups/${board.id}/proposals`, { kind: 'free', title: secret, body: 'Price to be agreed', method: 'ranked', options: ['Now', 'Next year'] }).expect(201)).body;
    expect(pr.label).toBe('confidential');
    const row = await h.s.db('group_proposals').where({ id: pr.id }).first();
    expect(row.label).toBe('confidential');
    for (const v of Object.values(row)) expect(String(v)).not.toContain('north field');
    expect(String(row.content)).not.toContain('Next year');
    const opened = JSON.parse((await h.s.keys.open(h.tenantId, row.content, `group-proposal:${pr.id}`))!);
    expect(opened).toMatchObject({ title: secret, body: 'Price to be agreed', options: [{ id: 'o1', label: 'Now' }, { id: 'o2', label: 'Next year' }] });
    // opened with another proposal's id it does not open
    await expect(h.s.keys.open(h.tenantId, row.content, 'group-proposal:other')).rejects.toThrow();
    // nobody below the label reads it
    const low = await personIn(h, 'frank', [conf]);
    await low.get(`/api/group-proposals/${pr.id}`).expect(404);
    // audit entries carry no text
    for (const e of await audits(h, 'group.proposal.created')) expect(JSON.stringify(e)).not.toContain('north field');
  });
});

describe('group governance before migrations 133 and 134 (B-174)', () => {
  it('reports itself unavailable and changes nothing', async () => {
    const { harness } = await import('./helpers.js');
    const h = await harness();
    try {
      if (await h.s.db.schema.hasTable('group_proposals')) return; // registered: nothing to check here
      const ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Commons', 'internal')).id;
      const alice = await personIn(h, 'alice', [ws]);
      const g = (await alice.post('/api/groups', { workspaceId: ws, name: 'Early', joinMode: 'open', visibility: 'public' }).expect(201)).body;
      expect((await alice.get(`/api/groups/${g.id}/governance`).expect(200)).body).toEqual({ available: false, groupId: g.id });
      expect((await alice.get(`/api/groups/${g.id}/proposals`).expect(200)).body).toEqual({ available: false, proposals: [] });
      expect((await alice.get(`/api/groups/${g.id}/budget`).expect(200)).body.available).toBe(false);
      expect((await alice.post(`/api/groups/${g.id}/proposals`, { kind: 'free', title: 'Too soon' }).expect(503)).body.reason).toBe('migration_pending');
      await alice.put(`/api/groups/${g.id}/governance`, { propose: 'owners' }).expect(503);
      await alice.put(`/api/groups/${g.id}/budget`, { currency: 'EUR' }).expect(503);
      expect(await h.s.groupGovernance.tick(h.tenantId)).toEqual({ closed: 0, reminded: 0 });
    } finally {
      await h.close();
    }
  }, 120_000);
});
