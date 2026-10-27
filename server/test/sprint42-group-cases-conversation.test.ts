import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';

/*
 * Sprint 42 (1.7.0), groups: moderators acting on cases, and a group's linked conversation.
 * The "done when" of each item is a test below:
 *   B-9706 a report on a group post reaches that group's moderators, and their ban is enforced;
 *   B-9709 leaving the group removes the member from the linked conversation.
 */

type Person = Awaited<ReturnType<typeof personIn>>;

async function personIn(h: Harness, name: string, workspaces: string[], roles: string[] = ['member'], clearance: 'internal' | 'confidential' = 'internal') {
  const user = await localUser(h, name, roles, clearance);
  for (const w of workspaces) await h.s.tenants.addMember(w, user.id);
  const c: Client = roles.some((r) => r !== 'member') ? await loginAdmin(h, name) : await login(h, name);
  const send = (method: 'post' | 'patch' | 'put' | 'delete', path: string, body: object = {}) => c.agent[method](path).set('x-csrf-token', c.csrf).send(body);
  return { user, ...c, post: (p: string, b?: object) => send('post', p, b), put: (p: string, b?: object) => send('put', p, b), patch: (p: string, b?: object) => send('patch', p, b), del: (p: string) => send('delete', p), get: (p: string) => c.agent.get(p) };
}

const audits = (h: Harness, action: string) => h.s.db('audit_events').where({ action }) as Promise<{ detail: string | null; target: string | null }[]>;
const bodies = async (x: Person, cid: string): Promise<(string | null)[]> => {
  const b = (await x.get(`/api/messaging/conversations/${cid}/messages`).expect(200)).body as { body: string | null }[] | { items?: { body: string | null }[]; messages?: { body: string | null }[] };
  return (Array.isArray(b) ? b : (b.items ?? b.messages ?? [])).map((m) => m.body);
};
const notes = async (h: Harness, userId: string) => ((await h.s.db('notifications').where({ tenant_id: h.tenantId, user_id: userId })) as { title: string; kind: string }[]).map((n) => n.title).join('|');

describe('groups: cases for moderators, and the linked conversation (Sprint 42)', () => {
  let h: Harness;
  let ws: string;
  let alice: Person;
  let bob: Person;
  let carol: Person;
  let dave: Person;
  let erin: Person;

  beforeEach(async () => {
    h = await harness();
    ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Design', 'confidential')).id;
    alice = await personIn(h, 'alice', [ws], ['member'], 'confidential');
    bob = await personIn(h, 'bob', [ws]);
    carol = await personIn(h, 'carol', [ws]);
    dave = await personIn(h, 'dave', [ws]);
    erin = await personIn(h, 'erin', [ws]);
  }, 120_000);
  afterEach(async () => {
    await h.close();
  });

  /** Alice owns the group, Carol moderates it, Bob, Dave and Erin are members. */
  async function club(name = 'Type club') {
    const g = (await alice.post('/api/groups', { workspaceId: ws, name, joinMode: 'open', visibility: 'public' }).expect(201)).body;
    for (const x of [bob, carol, dave, erin]) await x.post(`/api/groups/${g.id}/join`).expect(200);
    await alice.patch(`/api/groups/${g.id}/members/${carol.user.id}`, { role: 'moderator' }).expect(200);
    return g as { id: string };
  }

  it('B-9706: a report on a group post reaches that group’s moderators, and their ban is enforced', async () => {
    const g = await club();
    const other = (await dave.post('/api/groups', { workspaceId: ws, name: 'Elsewhere', joinMode: 'open', visibility: 'public' }).expect(201)).body;
    const post = (await bob.post(`/api/groups/${g.id}/posts`, { body: 'Buy my fonts, cheap, today only' }).expect(201)).body;
    const elsewhere = (await dave.post(`/api/groups/${other.id}/posts`, { body: 'Another group’s post' }).expect(201)).body;

    // Erin reports Bob's post: the owner and the moderator are told, the reporter and the author are not
    const report = (await erin.post('/api/moderation/reports', { type: 'group-post', id: post.id, reason: 'Spam' }).expect(201)).body;
    const ref = report.flag.ref as string;
    expect(await notes(h, alice.user.id)).toContain('A case was opened in Type club');
    expect(await notes(h, carol.user.id)).toContain('A case was opened in Type club');
    expect(await notes(h, erin.user.id)).not.toContain('A case was opened');
    expect(await notes(h, bob.user.id)).not.toContain('A case was opened');
    // and a report in another group reaches neither of them
    const far = (await erin.post('/api/moderation/reports', { type: 'group-post', id: elsewhere.id, reason: 'Spam' }).expect(201)).body;

    // reach: a member reads no cases; a moderator reads the group's and nothing else of the tenant's
    await erin.get(`/api/groups/${g.id}/cases`).expect(403);
    const list = (await carol.get(`/api/groups/${g.id}/cases`).expect(200)).body as { ref: string; groupId: string; hideable: boolean }[];
    expect(list).toEqual([expect.objectContaining({ ref, groupId: g.id, objectType: 'group-post', state: 'open', hideable: true })]);
    await carol.get(`/api/groups/${g.id}/cases/${far.flag.ref}`).expect(404);
    await carol.post(`/api/groups/${g.id}/cases/${far.flag.ref}/act`, { action: 'dismiss' }).expect(404);
    await erin.post(`/api/groups/${g.id}/cases/${ref}/act`, { action: 'dismiss' }).expect(403);
    const detail = (await carol.get(`/api/groups/${g.id}/cases/${ref}`).expect(200)).body;
    expect(detail).toMatchObject({ ref, groupId: g.id, own: false, object: { type: 'group-post', id: post.id, ownerId: bob.user.id, ownerName: 'BOB', hideable: true } });

    // assignment: to a moderator of the group only, never to the author; the assignee is told
    expect((await carol.post(`/api/groups/${g.id}/cases/${ref}/assign`, { userId: erin.user.id }).expect(422)).body.step).toBe('assignee');
    expect((await carol.get(`/api/groups/${g.id}/cases/${ref}/moderators`).expect(200)).body.map((m: { userId: string }) => m.userId).sort()).toEqual([alice.user.id, carol.user.id].sort());
    expect((await carol.post(`/api/groups/${g.id}/cases/${ref}/assign`, { userId: alice.user.id }).expect(200)).body).toMatchObject({ assignee: alice.user.id, assigneeName: 'ALICE' });
    expect(await notes(h, alice.user.id)).toContain('A case in Type club was assigned to you');
    // assigned to the owner: the moderator leaves it alone, the owner hands it back
    expect((await carol.post(`/api/groups/${g.id}/cases/${ref}/act`, { action: 'dismiss' }).expect(409)).body.step).toBe('assignee');
    await alice.post(`/api/groups/${g.id}/cases/${ref}/assign`, { userId: carol.user.id }).expect(200);

    // hide: a moderation action on the post, kept as evidence, that its author is told of
    const hidden = (await carol.post(`/api/groups/${g.id}/cases/${ref}/act`, { action: 'hide', note: 'Advertising' }).expect(200)).body;
    expect(hidden.state).toBe('confirmed');
    expect(hidden.actions.map((a: { action: string }) => a.action)).toEqual(['assign', 'assign', 'hide']);
    const actionId = hidden.actions[2].moderationActionId as string;
    expect(await h.s.db('moderation_actions').where({ id: actionId }).first()).toMatchObject({ object_type: 'group-post', object_id: post.id, state: 'applied', created_by: carol.user.id });
    expect((await h.s.db('group_posts').where({ id: post.id }).first()).state).toBe('hidden');
    expect((await h.s.evidence.keptOf(h.tenantId, 'group-post')).has(post.id)).toBe(true);
    expect(((await erin.get(`/api/groups/${g.id}/posts`).expect(200)).body as { id: string; state: string; body: string | null }[]).filter((x) => x.id === post.id && x.state !== 'hidden' && x.body)).toHaveLength(0);

    // warn: the author is sent what the moderator wrote
    const warned = (await carol.post(`/api/groups/${g.id}/cases/${ref}/act`, { action: 'warn', note: 'No advertising here, please.' }).expect(200)).body;
    expect(warned.actions.at(-1)).toMatchObject({ action: 'warn', userId: bob.user.id, note: 'No advertising here, please.' });
    expect(await notes(h, bob.user.id)).toContain('A moderator of Type club warned you');
    await carol.post(`/api/groups/${g.id}/cases/${ref}/act`, { action: 'warn' }).expect(400);

    // ban: through the group's bans, and it is enforced
    const banned = (await carol.post(`/api/groups/${g.id}/cases/${ref}/act`, { action: 'ban', days: 7, note: 'Repeated advertising' }).expect(200)).body;
    const banId = banned.actions.at(-1).banId as string;
    expect(await h.s.db('group_bans').where({ id: banId }).first()).toMatchObject({ group_id: g.id, user_id: bob.user.id, kind: 'ban', created_by: carol.user.id });
    expect(await h.s.db('group_members').where({ group_id: g.id, user_id: bob.user.id })).toHaveLength(0);
    expect((await bob.post(`/api/groups/${g.id}/join`).expect(403)).body).toMatchObject({ step: 'ban', kind: 'ban' });
    expect((await alice.post(`/api/groups/${g.id}/invites`, { userId: bob.user.id }).expect(409)).body.step).toBe('ban');
    // one stands at a time: the group's own rule answers
    await carol.post(`/api/groups/${g.id}/cases/${ref}/act`, { action: 'suspend', days: 3 }).expect(409);
    // every decision is audited
    for (const a of ['group.case.assigned', 'group.case.hide', 'group.case.warn', 'group.case.ban']) expect((await audits(h, a)).length, a).toBeGreaterThan(0);
    expect(JSON.parse((await audits(h, 'group.case.ban'))[0]!.detail!)).toMatchObject({ ban: banId, flagState: 'confirmed' });

    // the appeal of the hide goes to the group's moderators: not to the one who decided, nor decided by her
    const appeal = (await bob.post('/api/moderation/appeals', { actionId, statement: 'It was a typeface I drew myself.' }).expect(201)).body;
    expect(await notes(h, alice.user.id)).toContain('An appeal waits in Type club');
    expect(await notes(h, carol.user.id)).not.toContain('An appeal waits');
    await erin.get(`/api/groups/${g.id}/appeals`).expect(403);
    const appeals = (await carol.get(`/api/groups/${g.id}/appeals`).expect(200)).body;
    expect(appeals).toEqual([expect.objectContaining({ ref: appeal.ref, groupId: g.id, state: 'pending', decidable: false, statement: null })]);
    expect((await carol.post(`/api/groups/${g.id}/appeals/${appeal.ref}/decide`, { decision: 'denied' }).expect(403)).body.step).toBe('independence');
    expect((await alice.get(`/api/groups/${g.id}/appeals/${appeal.ref}`).expect(200)).body).toMatchObject({ statement: 'It was a typeface I drew myself.', groupId: g.id });
    // another group's moderator has no reach to it
    await dave.post(`/api/groups/${other.id}/appeals/${appeal.ref}/decide`, { decision: 'upheld' }).expect(404);
    const decided = (await alice.post(`/api/groups/${g.id}/appeals/${appeal.ref}/decide`, { decision: 'upheld', note: 'Fair enough.' }).expect(200)).body;
    expect(decided.appeal.state).toBe('upheld');
    expect(decided.effects).toMatchObject({ restored: true });
    expect((await h.s.db('group_posts').where({ id: post.id }).first()).state).toBe('published');
    expect((await audits(h, 'group.case.appeal.upheld')).length).toBe(1);
    // the case is open again; the ban stands until a moderator lifts it
    expect((await carol.get(`/api/groups/${g.id}/cases/${ref}`).expect(200)).body.state).toBe('open');
    await bob.post(`/api/groups/${g.id}/join`).expect(403);
  });

  it('B-9706: nobody decides a case about their own content, and a channel’s cases are its moderators’', async () => {
    const g = await club();
    const mine = (await carol.post(`/api/groups/${g.id}/posts`, { body: 'A moderator’s own post' }).expect(201)).body;
    const ref = (await erin.post('/api/moderation/reports', { type: 'group-post', id: mine.id, reason: 'Rude' }).expect(201)).body.flag.ref as string;
    expect(await notes(h, carol.user.id)).not.toContain('A case was opened');
    expect((await carol.get(`/api/groups/${g.id}/cases/${ref}`).expect(200)).body.own).toBe(true);
    for (const action of ['confirm', 'dismiss', 'hide']) expect((await carol.post(`/api/groups/${g.id}/cases/${ref}/act`, { action }).expect(403)).body.step, action).toBe('independence');
    expect((await alice.post(`/api/groups/${g.id}/cases/${ref}/assign`, { userId: carol.user.id }).expect(403)).body.step).toBe('independence');
    // an owner is not banned from a case either: the group's own rule answers
    await alice.patch(`/api/groups/${g.id}/members/${carol.user.id}`, { role: 'owner' }).expect(200);
    await alice.post(`/api/groups/${g.id}/cases/${ref}/act`, { action: 'ban' }).expect(409);
    expect((await alice.post(`/api/groups/${g.id}/cases/${ref}/act`, { action: 'dismiss', note: 'Nothing wrong with it' }).expect(200)).body.state).toBe('dismissed');
    await alice.post(`/api/groups/${g.id}/cases/${ref}/act`, { action: 'confirm' }).expect(409);

    // a channel: the group's owners act in it; a moderator of the group who does not moderate the channel does not
    await alice.patch(`/api/groups/${g.id}/members/${carol.user.id}`, { role: 'moderator' }).expect(200);
    const ch = (await alice.post(`/api/groups/${g.id}/channels`, { name: 'Kerning' }).expect(201)).body;
    await dave.post(`/api/groups/${ch.id}/join`).expect(200);
    await erin.post(`/api/groups/${ch.id}/join`).expect(200);
    const inChannel = (await dave.post(`/api/groups/${ch.id}/posts`, { body: 'Too tight' }).expect(201)).body;
    const chRef = (await erin.post('/api/moderation/reports', { type: 'group-post', id: inChannel.id, reason: 'Rude' }).expect(201)).body.flag.ref as string;
    expect(((await alice.get(`/api/groups/${g.id}/cases?state=open`).expect(200)).body as { ref: string; groupId: string }[]).find((c) => c.ref === chRef)).toMatchObject({ groupId: ch.id, groupName: 'Kerning' });
    expect(((await carol.get(`/api/groups/${g.id}/cases?state=open`).expect(200)).body as { ref: string }[]).map((c) => c.ref)).not.toContain(chRef);
    await carol.post(`/api/groups/${g.id}/cases/${chRef}/act`, { action: 'dismiss' }).expect(404);
    expect((await alice.post(`/api/groups/${g.id}/cases/${chRef}/act`, { action: 'suspend', days: 2 }).expect(200)).body.state).toBe('confirmed');
    expect(await h.s.db('group_bans').where({ group_id: ch.id, user_id: dave.user.id, kind: 'suspend' })).toHaveLength(1);
  });

  it('B-9709: leaving the group removes the member from the linked conversation', async () => {
    const g = await club();
    // only an owner links, and the label is never below the group's
    await carol.put(`/api/groups/${g.id}/conversation`, {}).expect(403);
    expect((await alice.get(`/api/groups/${g.id}/conversation`).expect(200)).body).toEqual({ linked: false, canLink: true });
    expect((await alice.put(`/api/groups/${g.id}/conversation`, { label: 'public' }).expect(422)).body.step).toBe('label-floor');
    const linked = (await alice.put(`/api/groups/${g.id}/conversation`, {}).expect(201)).body;
    expect(linked).toMatchObject({ linked: true, label: 'internal', title: 'Type club', member: true });
    const cid = linked.conversationId as string;
    expect(JSON.parse((await audits(h, 'group.conversation.linked'))[0]!.detail!)).toMatchObject({ created: true, membersAdded: 5, membersRemoved: 0 });
    await alice.put(`/api/groups/${g.id}/conversation`, {}).expect(409);

    // its members are the group's, with the group's roles
    const seen = (await bob.get(`/api/messaging/conversations/${cid}`).expect(200)).body;
    expect(seen).toMatchObject({ kind: 'group', groupId: g.id, members: 5, role: 'member' });
    expect((await carol.get(`/api/messaging/conversations/${cid}`).expect(200)).body.role).toBe('admin');
    expect((await alice.get(`/api/messaging/conversations/${cid}`).expect(200)).body.role).toBe('owner');
    await bob.post(`/api/messaging/conversations/${cid}/messages`, { body: 'Hello, club' }).expect(201);

    // nobody is added, removed or leaves in the conversation itself
    const outsider = await personIn(h, 'frank', [ws]);
    expect((await alice.post(`/api/messaging/conversations/${cid}/members`, { userId: outsider.user.id }).expect(409)).body.step).toBe('group-link');
    expect((await alice.del(`/api/messaging/conversations/${cid}/members/${bob.user.id}`).expect(409)).body.step).toBe('group-link');
    expect((await bob.del(`/api/messaging/conversations/${cid}/members/${bob.user.id}`).expect(409)).body.step).toBe('group-link');
    expect((await alice.patch(`/api/messaging/conversations/${cid}/members/${bob.user.id}`, { role: 'admin' }).expect(409)).body.step).toBe('group-link');

    // joining the group joins the conversation, reading from then on
    await outsider.post(`/api/groups/${g.id}/join`).expect(200);
    expect((await outsider.get(`/api/messaging/conversations/${cid}`).expect(200)).body.members).toBe(6);
    expect(await bodies(outsider, cid)).not.toContain('Hello, club');

    // done when: leaving the group removes the member from the conversation
    await bob.del(`/api/groups/${g.id}/members/${bob.user.id}`).expect(200);
    expect(await h.s.db('dm_members').where({ conversation_id: cid, user_id: bob.user.id })).toHaveLength(0);
    await bob.get(`/api/messaging/conversations/${cid}`).expect(404);
    await bob.post(`/api/messaging/conversations/${cid}/messages`, { body: 'Still here?' }).expect(404);
    expect(((await bob.get('/api/messaging/conversations').expect(200)).body as { id: string }[]).map((c) => c.id)).not.toContain(cid);
    // rejoining reads from the rejoin on; what he wrote before stays for the others
    await bob.post(`/api/groups/${g.id}/join`).expect(200);
    expect(await bodies(bob, cid)).not.toContain('Hello, club');
    expect(await bodies(erin, cid)).toContain('Hello, club');

    // a removal by a moderator, too
    await carol.del(`/api/groups/${g.id}/members/${outsider.user.id}`).expect(200);
    await outsider.get(`/api/messaging/conversations/${cid}`).expect(404);

    // a suspension closes the conversation for its time and tells them nothing of it; lifting it opens it again
    const sus = (await carol.post(`/api/groups/${g.id}/bans`, { userId: dave.user.id, kind: 'suspend', days: 2 }).expect(201)).body;
    await dave.get(`/api/messaging/conversations/${cid}`).expect(404);
    expect(((await dave.get('/api/messaging/conversations').expect(200)).body as { id: string }[]).map((c) => c.id)).not.toContain(cid);
    expect(await h.s.db('dm_members').where({ conversation_id: cid, user_id: dave.user.id })).toHaveLength(1);
    const before = (await h.s.db('notifications').where({ user_id: dave.user.id, kind: 'message' })).length;
    await erin.post(`/api/messaging/conversations/${cid}/messages`, { body: 'While Dave is away' }).expect(201);
    expect((await h.s.db('notifications').where({ user_id: dave.user.id, kind: 'message' })).length).toBe(before);
    expect((await h.s.db('notifications').where({ user_id: alice.user.id, kind: 'message' })).length).toBeGreaterThan(0);
    await carol.del(`/api/groups/${g.id}/bans/${sus.id}`).expect(200);
    expect((await dave.get(`/api/messaging/conversations/${cid}`).expect(200)).body.role).toBe('member');
    // a suspension that runs out ends the same way, without anyone acting
    const sus2 = (await carol.post(`/api/groups/${g.id}/bans`, { userId: dave.user.id, kind: 'suspend', days: 2 }).expect(201)).body;
    await dave.get(`/api/messaging/conversations/${cid}`).expect(404);
    await h.s.db('group_bans').where({ id: sus2.id }).update({ expires_at: Date.now() - 1000 });
    await dave.get(`/api/messaging/conversations/${cid}`).expect(200);

    // a ban takes the member out of the conversation
    await carol.post(`/api/groups/${g.id}/bans`, { userId: erin.user.id, kind: 'ban' }).expect(201);
    expect(await h.s.db('dm_members').where({ conversation_id: cid, user_id: erin.user.id })).toHaveLength(0);
    await erin.get(`/api/messaging/conversations/${cid}`).expect(404);

    // the group's label does not rise above its conversation's
    expect((await alice.patch(`/api/groups/${g.id}`, { label: 'confidential' }).expect(422)).body.step).toBe('label-floor');

    // removing the link leaves an ordinary conversation with the people in it, and their roles written back
    await carol.del(`/api/groups/${g.id}/conversation`).expect(403);
    expect((await alice.del(`/api/groups/${g.id}/conversation`).expect(200)).body).toEqual({ linked: false, conversationId: cid });
    expect((await audits(h, 'group.conversation.unlinked')).length).toBe(1);
    expect((await carol.get(`/api/messaging/conversations/${cid}`).expect(200)).body).toMatchObject({ role: 'admin', groupId: null });
    await dave.del(`/api/groups/${g.id}/members/${dave.user.id}`).expect(200);
    expect((await dave.get(`/api/messaging/conversations/${cid}`).expect(200)).body.role).toBe('member');
    await alice.patch(`/api/groups/${g.id}`, { label: 'confidential' }).expect(200);
  });

  it('B-9709: an existing conversation is linked only by its owner, and nobody is removed from it unasked', async () => {
    const g = await club();
    const outsider = await personIn(h, 'frank', [ws]);
    const conv = (await alice.post('/api/messaging/conversations', { kind: 'group', workspaceId: ws, title: 'Old chat', memberIds: [bob.user.id, outsider.user.id] }).expect(201)).body;
    const carols = (await carol.post('/api/messaging/conversations', { kind: 'group', workspaceId: ws, title: 'Carol’s', memberIds: [alice.user.id] }).expect(201)).body;
    await alice.post(`/api/messaging/conversations/${conv.id}/messages`, { body: 'Before the link' }).expect(201);

    // not the owner of the conversation: refused; someone outside the group in it: refused until confirmed
    await alice.put(`/api/groups/${g.id}/conversation`, { conversationId: carols.id }).expect(403);
    expect((await alice.put(`/api/groups/${g.id}/conversation`, { conversationId: conv.id }).expect(409)).body).toMatchObject({ step: 'members', outside: 1 });
    expect(await h.s.db('dm_members').where({ conversation_id: conv.id })).toHaveLength(3);
    expect(await h.s.db('group_conversations').where({ group_id: g.id })).toHaveLength(0);

    const linked = (await alice.put(`/api/groups/${g.id}/conversation`, { conversationId: conv.id, removeOthers: true }).expect(201)).body;
    expect(linked).toMatchObject({ linked: true, conversationId: conv.id, title: 'Old chat' });
    expect(JSON.parse((await audits(h, 'group.conversation.linked'))[0]!.detail!)).toMatchObject({ created: false, removedOutsideGroup: 1, membersRemoved: 1, membersAdded: 3 });
    await outsider.get(`/api/messaging/conversations/${conv.id}`).expect(404);
    // who was in it keeps its history; who came in with the link reads from then on
    expect(await bodies(bob, conv.id)).toContain('Before the link');
    expect(await bodies(erin, conv.id)).not.toContain('Before the link');
    // a conversation is linked to one group
    const g2 = (await alice.post('/api/groups', { workspaceId: ws, name: 'Second', joinMode: 'open', visibility: 'public' }).expect(201)).body;
    await alice.put(`/api/groups/${g2.id}/conversation`, { conversationId: conv.id }).expect(409);

    // deleting the group leaves the conversation to the people in it
    await alice.del(`/api/groups/${g.id}`).expect(200);
    expect(await h.s.db('group_conversations').where({ group_id: g.id })).toHaveLength(0);
    expect((await bob.get(`/api/messaging/conversations/${conv.id}`).expect(200)).body).toMatchObject({ groupId: null, role: 'member' });
    expect(JSON.parse((await audits(h, 'group.conversation.unlinked'))[0]!.detail!)).toMatchObject({ reason: 'group-deleted' });
  });
});
