import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { groupPrincipal } from '../src/groups/service-principal.js';
import { audits, club, expire, personIn, world, type Person, type World } from './group-governance-helpers.js';

/*
 * 1.9.0, Sprint 53 (B-176): carrying out a decision. A passed proposal is applied through the group's own services as
 * the group (an owner's standing in that group and nothing more), owners may require their confirmation for some
 * kinds, a failure is kept on the proposal and posted to the conversation, and a decision is carried out at most once.
 */

describe('group decisions (B-176)', () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  }, 120_000);
  afterEach(async () => {
    await w.h.close();
  });

  /** Drafts, opens and passes a proposal (everyone named votes yes), then ends voting and reads it. */
  async function pass(by: Person, groupId: string, body: Record<string, unknown>, voters: Person[]) {
    const pr = (await by.post(`/api/groups/${groupId}/proposals`, body).expect(201)).body as { id: string };
    await by.post(`/api/group-proposals/${pr.id}/open`).expect(200);
    for (const x of voters) await x.post(`/api/group-proposals/${pr.id}/ballots`, { choice: 'yes' }).expect(200);
    await expire(w.h, pr.id);
    return (await by.get(`/api/group-proposals/${pr.id}`).expect(200)).body;
  }

  it('is carried out through the group’s services, as the group', async () => {
    const { h, alice, bob, carol, erin } = w;
    const g = await club(w, [bob, carol]);
    const voters = [alice, bob, carol];
    // a setting
    const s1 = await pass(bob, g.id, { kind: 'setting', title: 'Rename', action: { patch: { name: 'Allotment club', joinMode: 'request', tags: ['soil'] } } }, voters);
    expect(s1).toMatchObject({ state: 'carried_out', carriedResult: { changed: ['name', 'joinMode', 'tags'] } });
    expect(await h.s.db('social_groups').where({ id: g.id }).first()).toMatchObject({ name: 'Allotment club', join_mode: 'request' });
    const updated = (await audits(h, 'group.updated')).at(-1)!;
    expect(updated.actor).toMatchObject({ user: g.id, username: 'group-decision', name: 'Garden club (by decision)', roles: [] });
    // a member, invited as an owner would (the group does not add people directly)
    const s2 = await pass(bob, g.id, { kind: 'member', title: 'Invite Erin', action: { op: 'add', userId: erin.user.id } }, voters);
    expect(s2).toMatchObject({ state: 'carried_out', carriedResult: { invited: erin.user.id } });
    expect(await h.s.db('group_requests').where({ group_id: g.id, user_id: erin.user.id, state: 'pending' }).first()).toMatchObject({ kind: 'invite', created_by: g.id });
    // a member who asked to join is accepted instead
    const frank = await personIn(h, 'frank', [w.ws]);
    expect((await frank.post(`/api/groups/${g.id}/join`).expect(202)).body.requested).toBe(true);
    const s3 = await pass(bob, g.id, { kind: 'member', title: 'Let Frank in', action: { op: 'add', userId: frank.user.id } }, voters);
    expect(s3.carriedResult).toMatchObject({ joined: frank.user.id });
    expect(await h.s.db('group_members').where({ group_id: g.id, user_id: frank.user.id }).first()).toMatchObject({ role: 'member' });
    // a role, the rules and a spend
    await pass(bob, g.id, { kind: 'role', title: 'Carol admin', action: { userId: carol.user.id, role: 'admin' } }, voters);
    expect((await h.s.db('group_members').where({ group_id: g.id, user_id: carol.user.id }).first()).role).toBe('admin');
    await pass(bob, g.id, { kind: 'rules', title: 'Rules', action: { rules: 'Close the gate.' } }, voters);
    expect((await bob.get(`/api/groups/${g.id}/governance`).expect(200)).body.rules).toBe('Close the gate.');
    await alice.put(`/api/groups/${g.id}/budget`, { currency: 'EUR' }).expect(200);
    await alice.post(`/api/groups/${g.id}/budget/entries`, { amountMinor: 10_000, memo: 'Membership fees' }).expect(201);
    await bob.post(`/api/groups/${g.id}/budget/entries`, { amountMinor: 1 }).expect(403);
    const sp = await pass(bob, g.id, { kind: 'spend', title: 'A hose', action: { amountMinor: 2500, memo: 'Garden hose' } }, voters);
    expect(sp).toMatchObject({ state: 'carried_out', carriedResult: { amountMinor: -2500, currency: 'EUR', balanceAfter: 7500 } });
    const budget = (await carol.get(`/api/groups/${g.id}/budget`).expect(200)).body;
    expect(budget).toMatchObject({ currency: 'EUR', balanceMinor: 7500 });
    expect(budget.entries[0]).toMatchObject({ amountMinor: -2500, memo: 'Garden hose', proposalId: sp.id, createdBy: g.id, createdByName: 'By decision' });
    for (const a of ['group.decision.applied', 'group.member.role', 'group.governance.updated', 'group.budget.spent', 'group.invite.created', 'group.request.accepted']) expect((await audits(h, a)).length, a).toBeGreaterThan(0);
    expect((await audits(h, 'group.decision.applied')).at(-1)!.actor).toMatchObject({ user: g.id, service: 'groups.governance' });
  });

  it('acts with an owner’s standing in its own group only', async () => {
    const { h, alice, bob } = w;
    const g = await club(w, [bob]);
    const other = (await bob.post('/api/groups', { workspaceId: w.ws, name: 'Elsewhere', joinMode: 'open', visibility: 'public' }).expect(201)).body;
    const row = (await h.s.groups.row(h.tenantId, g.id))!;
    const p = groupPrincipal(row);
    const a = await h.s.groups.accessOrNull(p, g.id);
    expect(a).toMatchObject({ role: 'owner', manager: false, read: true });
    expect([...a!.rights].sort()).toEqual(['cases', 'channels', 'check-in', 'decide', 'delete', 'events', 'invite', 'moderate', 'post', 'read', 'remove-members', 'roles', 'rsvp', 'settings']);
    expect(await h.s.groups.accessOrNull(p, other.id)).toBeNull();
    // a principal that only looks like it (same fields, not made by groupPrincipal) is nobody
    expect(await h.s.groups.accessOrNull({ ...p }, g.id)).toBeNull();
    // and the last-owner rule holds for it as for anyone
    await expect(h.s.groups.setRole({ p, ip: null }, g.id, alice.user.id, 'member')).rejects.toThrow(/at least one owner/);
  });

  it('waits for an owner’s confirmation for the kinds the owners chose', async () => {
    const { h, alice, bob, carol } = w;
    const g = await club(w, [bob, carol]);
    await alice.put(`/api/groups/${g.id}/governance`, { confirmKinds: ['setting', 'member'] }).expect(200);
    const voters = [alice, bob, carol];
    const pr = await pass(bob, g.id, { kind: 'setting', title: 'Private', action: { patch: { visibility: 'private' } } }, voters);
    expect(pr).toMatchObject({ state: 'closed', outcome: 'passed', needsConfirmation: true, carriedAt: null, can: { confirm: false } });
    expect((await h.s.db('social_groups').where({ id: g.id }).first()).visibility).toBe('public');
    expect((await h.s.db('notifications').where({ user_id: alice.user.id, kind: 'group.governance' })).map((n: { title: string }) => n.title)).toContain('A decision in Garden club waits for an owner’s confirmation');
    // a member does not confirm; an owner does, and it is carried out
    expect((await bob.post(`/api/group-proposals/${pr.id}/confirm`).expect(403)).body.step).toBe('owner');
    expect((await alice.get(`/api/group-proposals/${pr.id}`).expect(200)).body.can.confirm).toBe(true);
    const done = (await alice.post(`/api/group-proposals/${pr.id}/confirm`).expect(200)).body;
    expect(done).toMatchObject({ state: 'carried_out', confirmedBy: alice.user.id, confirmedByName: 'ALICE' });
    expect((await h.s.db('social_groups').where({ id: g.id }).first()).visibility).toBe('private');
    await alice.post(`/api/group-proposals/${pr.id}/confirm`).expect(409);
    // an owner may decline instead: it is not carried out
    const rm = await pass(bob, g.id, { kind: 'member', title: 'Remove Carol', action: { op: 'remove', userId: carol.user.id } }, voters);
    expect(rm.needsConfirmation).toBe(true);
    const declined = (await alice.post(`/api/group-proposals/${rm.id}/decline`, { reason: 'We talked it over' }).expect(200)).body;
    expect(declined).toMatchObject({ state: 'failed', failure: 'Declined by an owner: We talked it over' });
    expect(await h.s.db('group_members').where({ group_id: g.id, user_id: carol.user.id }).first()).toBeTruthy();
    await alice.post(`/api/group-proposals/${rm.id}/confirm`).expect(409);
    // a kind not chosen is carried out at once
    const role = await pass(bob, g.id, { kind: 'role', title: 'Carol moderates', action: { userId: carol.user.id, role: 'moderator' } }, voters);
    expect(role.state).toBe('carried_out');
    for (const a of ['group.decision.awaiting', 'group.decision.confirmed', 'group.decision.declined']) expect((await audits(h, a)).length, a).toBe(a === 'group.decision.awaiting' ? 2 : 1);
  });

  it('posts a failure to the proposal and to the conversation', async () => {
    const { h, alice, bob, carol } = w;
    const g = await club(w, [bob, carol]);
    const conv = (await alice.put(`/api/groups/${g.id}/conversation`, {}).expect(201)).body;
    await alice.put(`/api/groups/${g.id}/budget`, { currency: 'GBP' }).expect(200);
    await alice.post(`/api/groups/${g.id}/budget/entries`, { amountMinor: 1000 }).expect(201);
    const pr = await pass(bob, g.id, { kind: 'spend', title: 'A greenhouse', action: { amountMinor: 50_000, memo: 'Greenhouse' } }, [alice, bob, carol]);
    expect(pr.state).toBe('failed');
    expect(pr.failure).toMatch(/^Not enough in the budget: The budget holds 1000 GBP/);
    expect((await carol.get(`/api/groups/${g.id}/budget`).expect(200)).body.balanceMinor).toBe(1000);
    const failed = (await audits(h, 'group.decision.failed')).at(-1)!;
    expect(failed.detail).toMatchObject({ kind: 'spend', failure: pr.failure });
    const msgs = (await h.s.db('dm_messages').where({ conversation_id: conv.conversationId, author_id: g.id }).orderBy('created_at')) as { id: string; body: string; thread_id: string | null }[];
    const texts = await Promise.all(msgs.map((m) => h.s.keys.open(h.tenantId, m.body, `dm-message:${m.id}`)));
    expect(texts.some((t) => /could not be carried out\. Not enough in the budget/.test(t ?? ''))).toBe(true);
    expect(msgs.every((m) => m.thread_id === pr.discussion.messageId)).toBe(true);
    // the proposer and the owners are told
    expect((await h.s.db('notifications').where({ user_id: bob.user.id, kind: 'group.governance' })).map((n: { title: string }) => n.title)).toContain('A decision in Garden club could not be carried out');
  });

  it('is carried out at most once', async () => {
    const { h, alice, bob, carol } = w;
    const g = await club(w, [bob, carol]);
    await alice.put(`/api/groups/${g.id}/budget`, { currency: 'EUR' }).expect(200);
    await alice.post(`/api/groups/${g.id}/budget/entries`, { amountMinor: 10_000 }).expect(201);
    const pr = (await bob.post(`/api/groups/${g.id}/proposals`, { kind: 'spend', title: 'Seeds', action: { amountMinor: 300 } }).expect(201)).body;
    await bob.post(`/api/group-proposals/${pr.id}/open`).expect(200);
    for (const x of [alice, bob]) await x.post(`/api/group-proposals/${pr.id}/ballots`, { choice: 'yes' }).expect(200);
    await expire(h, pr.id);
    const row = (await h.s.groupGovernance.row(h.tenantId, pr.id))!;
    // several closers and carriers at once: one close, one spend
    await Promise.all([h.s.groupGovernance.closeDue(row), h.s.groupGovernance.closeDue(row), h.s.groupGovernance.tick(h.tenantId), alice.get(`/api/group-proposals/${pr.id}`), h.s.groupGovernance.carryOut(h.tenantId, pr.id, null)]);
    expect(await h.s.groupGovernance.carryOut(h.tenantId, pr.id, null)).toBe('skipped');
    expect(await h.s.groupGovernance.carryOut(h.tenantId, pr.id, null)).toBe('skipped');
    expect(await h.s.db('group_budget_entries').where({ proposal_id: pr.id })).toHaveLength(1);
    expect((await h.s.db('group_budgets').where({ group_id: g.id }).first()).balance_minor).toBe(9700);
    expect(await audits(h, 'group.proposal.closed')).toHaveLength(1);
    expect(await audits(h, 'group.decision.applied')).toHaveLength(1);
    expect((await alice.get(`/api/group-proposals/${pr.id}`).expect(200)).body.state).toBe('carried_out');
    // and the ledger itself refuses a second entry for the decision
    await expect(h.s.groupGovernance.budget.record({ p: groupPrincipal((await h.s.groups.row(h.tenantId, g.id))!), ip: null }, g.id, { amountMinor: -300, proposalId: pr.id })).rejects.toThrow(/already recorded/);
  });
});
