import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newCode, normaliseCode } from '../src/groups/invites.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';

/*
 * Sprint 42 (1.7.0), groups: bans and suspensions, invite links, and the message on a request or an invitation.
 * The "done when" of each item is a test below:
 *   B-9701 a banned member cannot rejoin an open group or be invited back until the ban ends;
 *   B-9702 an invite link with a limit of 3 admits three people and refuses the fourth.
 */

type Person = Awaited<ReturnType<typeof personIn>>;

async function personIn(h: Harness, name: string, workspaces: string[], roles: string[] = ['member']) {
  const user = await localUser(h, name, roles);
  for (const w of workspaces) await h.s.tenants.addMember(w, user.id);
  const c: Client = await login(h, name);
  const send = (method: 'post' | 'patch' | 'put' | 'delete', path: string, body: object = {}) => c.agent[method](path).set('x-csrf-token', c.csrf).send(body);
  return { user, ...c, post: (p: string, b?: object) => send('post', p, b), patch: (p: string, b?: object) => send('patch', p, b), del: (p: string) => send('delete', p), get: (p: string) => c.agent.get(p) };
}

const NUKE = { id: 'nuke', name: 'Never this', checkpoint: 'user-input', type: 'pattern', mechanism: { kind: 'pattern', pattern: '(?i)launch codes' }, action: 'block', stage: 'enforce' };
const WIRE = { id: 'wire', name: 'Wire transfers', checkpoint: 'user-input', type: 'pattern', mechanism: { kind: 'pattern', pattern: '(?i)wire transfer' }, action: 'require-approval', stage: 'enforce' };

async function rules(h: Harness, list: object[]) {
  await localUser(h, 'ga', ['guardrail-admin'], 'confidential');
  const ga = await loginAdmin(h, 'ga');
  const send = (method: 'post' | 'put', url: string, body: object = {}) => ga.agent[method](url).set('x-csrf-token', ga.csrf).send(body);
  const set = (await send('post', '/api/admin/guardrails/sets', { name: 'Group rules', scope: 'tenant' }).expect(201)).body;
  await send('put', `/api/admin/guardrails/sets/${set.id}/draft`, { rules: list }).expect(200);
  await send('post', `/api/admin/guardrails/sets/${set.id}/draft/publish`).expect(200);
}

const audits = (h: Harness, action: string) => h.s.db('audit_events').where({ action }) as Promise<{ detail: string | null }[]>;
const notes = (h: Harness, userId: string) => h.s.db('notifications').where({ tenant_id: h.tenantId, user_id: userId }) as Promise<{ title: string; kind: string }[]>;

describe('invite codes (B-9702)', () => {
  it('reads a code as typed: any case, any separators, O as 0 and I or L as 1', () => {
    const code = newCode();
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/);
    const plain = normaliseCode(code)!;
    expect(plain).toHaveLength(20);
    expect(normaliseCode(` ${code.toLowerCase().replace(/-/g, ' ')} `)).toBe(plain);
    expect(normaliseCode('OIL00-00000-00000-00000')).toBe('01100000000000000000');
    expect(normaliseCode('too-short')).toBeNull();
    expect(normaliseCode('UUUUU-UUUUU-UUUUU-UUUUU')).toBeNull();
  });
});

describe('groups: bans, invite links and messages (Sprint 42)', () => {
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
    alice = await personIn(h, 'alice', [ws]);
    bob = await personIn(h, 'bob', [ws]);
    carol = await personIn(h, 'carol', [ws]);
    dave = await personIn(h, 'dave', [ws]);
    erin = await personIn(h, 'erin', [ws]);
  }, 120_000);
  afterEach(async () => {
    await h.close();
  });

  it('B-9701: a banned member cannot rejoin an open group or be invited back until the ban ends', async () => {
    await rules(h, [NUKE]);
    const g = (await alice.post('/api/groups', { workspaceId: ws, name: 'Type club', joinMode: 'open', visibility: 'public' }).expect(201)).body;
    await bob.post(`/api/groups/${g.id}/join`).expect(200);
    await carol.post(`/api/groups/${g.id}/join`).expect(200);
    const link = (await alice.post(`/api/groups/${g.id}/invite-links`, {}).expect(201)).body;

    // who may ban, and whom
    await bob.post(`/api/groups/${g.id}/bans`, { userId: carol.user.id, kind: 'ban' }).expect(403);
    await alice.post(`/api/groups/${g.id}/bans`, { userId: alice.user.id, kind: 'ban' }).expect(400);
    await alice.patch(`/api/groups/${g.id}/members/${carol.user.id}`, { role: 'owner' }).expect(200);
    await alice.post(`/api/groups/${g.id}/bans`, { userId: carol.user.id, kind: 'ban' }).expect(409);
    await alice.patch(`/api/groups/${g.id}/members/${carol.user.id}`, { role: 'moderator' }).expect(200);
    expect((await alice.post(`/api/groups/${g.id}/bans`, { userId: bob.user.id, kind: 'ban', days: 7, reason: 'the launch codes' }).expect(422)).body.step).toBe('guardrails');

    // the ban: the member is removed and told until when, never why
    const ban = (await alice.post(`/api/groups/${g.id}/bans`, { userId: bob.user.id, kind: 'ban', days: 7, reason: 'Spam in every thread' }).expect(201)).body;
    expect(ban).toMatchObject({ userId: bob.user.id, kind: 'ban', state: 'active', reason: 'Spam in every thread', userName: 'BOB' });
    expect(ban.expiresAt).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    expect(await h.s.db('group_members').where({ group_id: g.id, user_id: bob.user.id })).toHaveLength(0);
    expect((await h.s.db('group_bans').where({ id: ban.id }).first()).reason).not.toContain('Spam');
    const seen = (await bob.get(`/api/groups/${g.id}`).expect(200)).body;
    expect(seen).toMatchObject({ role: null, standing: { kind: 'ban', until: ban.expiresAt } });
    expect(JSON.stringify(seen)).not.toContain('Spam');
    expect((await notes(h, bob.user.id)).map((n) => n.title).join('|')).toMatch(/You were banned from Type club until/);
    expect(JSON.parse((await audits(h, 'group.ban.created'))[0]!.detail!)).toMatchObject({ kind: 'ban', wasMember: true, removedMemberships: 1, hasReason: true });

    // every way back in is refused while it stands
    expect((await bob.post(`/api/groups/${g.id}/join`).expect(403)).body).toMatchObject({ step: 'ban', kind: 'ban', until: ban.expiresAt });
    expect((await alice.post(`/api/groups/${g.id}/invites`, { userId: bob.user.id }).expect(409)).body).toMatchObject({ step: 'ban', ban: ban.id });
    expect((await bob.post('/api/group-invites/redeem', { code: link.code }).expect(403)).body.step).toBe('ban');
    expect((await h.s.db('group_invite_links').where({ id: link.id }).first()).uses).toBe(0);
    expect(((await alice.get(`/api/groups/${g.id}/candidates`).expect(200)).body as { userId: string }[]).map((c) => c.userId)).not.toContain(bob.user.id);
    await alice.post(`/api/groups/${g.id}/bans`, { userId: bob.user.id, kind: 'ban' }).expect(409); // one stands at a time
    // a member reads no list of bans; a moderator does, with the reason
    await erin.get(`/api/groups/${g.id}/bans`).expect(403);
    expect((await carol.get(`/api/groups/${g.id}/bans`).expect(200)).body).toEqual([expect.objectContaining({ id: ban.id, reason: 'Spam in every thread', state: 'active' })]);

    // a ban withdraws what was pending, and nothing pending is accepted under one
    await alice.patch(`/api/groups/${g.id}`, { joinMode: 'request' }).expect(200);
    const asked = (await dave.post(`/api/groups/${g.id}/join`).expect(202)).body.request;
    await carol.post(`/api/groups/${g.id}/bans`, { userId: dave.user.id, kind: 'ban' }).expect(201);
    expect((await h.s.db('group_requests').where({ id: asked.id }).first()).state).toBe('cancelled');
    await alice.post(`/api/group-requests/${asked.id}/accept`).expect(409);
    expect((await dave.post(`/api/groups/${g.id}/join`).expect(403)).body).toMatchObject({ step: 'ban', until: null });
    await alice.patch(`/api/groups/${g.id}`, { joinMode: 'open' }).expect(200);

    // the ban ends: bob rejoins the open group, and can be invited again
    await h.s.db('group_bans').where({ id: ban.id }).update({ expires_at: Date.now() - 1000 });
    expect((await bob.get(`/api/groups/${g.id}`).expect(200)).body.standing).toBeNull();
    await bob.post(`/api/groups/${g.id}/join`).expect(200);
    expect((await carol.get(`/api/groups/${g.id}/bans?state=all`).expect(200)).body.find((b: { id: string }) => b.id === ban.id).state).toBe('ended');

    // lifting: only a moderator; dave may be invited back afterwards
    const daves = ((await alice.get(`/api/groups/${g.id}/bans`).expect(200)).body as { id: string; userId: string }[]).find((b) => b.userId === dave.user.id)!;
    await bob.del(`/api/groups/${g.id}/bans/${daves.id}`).expect(403);
    expect((await alice.del(`/api/groups/${g.id}/bans/${daves.id}`).expect(200)).body).toMatchObject({ state: 'lifted', liftedBy: alice.user.id });
    await alice.del(`/api/groups/${g.id}/bans/${daves.id}`).expect(409);
    await alice.post(`/api/groups/${g.id}/invites`, { userId: dave.user.id }).expect(201);
    expect(await audits(h, 'group.ban.lifted')).toHaveLength(1);
  }, 120_000);

  it('B-9701: a suspension leaves the membership without effect for its time, in the group and its channels', async () => {
    const g = (await alice.post('/api/groups', { workspaceId: ws, name: 'Press room', joinMode: 'open', visibility: 'private' }).expect(201)).body;
    await bob.post(`/api/groups/${g.id}/join`).expect(200);
    await carol.post(`/api/groups/${g.id}/join`).expect(200);
    const ch = (await alice.post(`/api/groups/${g.id}/channels`, { name: 'Proofs', joinMode: 'open' }).expect(201)).body;
    await bob.post(`/api/groups/${ch.id}/join`).expect(200);
    await bob.post(`/api/groups/${g.id}/posts`, { body: 'Before' }).expect(201);
    await alice.patch(`/api/groups/${g.id}/members/${carol.user.id}`, { role: 'moderator' }).expect(200);

    await alice.post(`/api/groups/${g.id}/bans`, { userId: erin.user.id, kind: 'suspend', days: 2 }).expect(409); // not a member
    await alice.post(`/api/groups/${g.id}/bans`, { userId: bob.user.id, kind: 'suspend' }).expect(400); // needs a length
    const sus = (await carol.post(`/api/groups/${g.id}/bans`, { userId: bob.user.id, kind: 'suspend', days: 2 }).expect(201)).body;
    expect(sus).toMatchObject({ kind: 'suspend', state: 'active' });
    // the membership stays, and counts for nothing: a private group and its channel are closed to them
    expect(await h.s.db('group_members').where({ user_id: bob.user.id }).whereIn('group_id', [g.id, ch.id])).toHaveLength(2);
    expect((await bob.get(`/api/groups/${g.id}`).expect(200)).body).toMatchObject({ role: null, standing: { kind: 'suspend', until: sus.expiresAt } });
    expect((await bob.post(`/api/groups/${g.id}/posts`, { body: 'During' }).expect(403)).body.step).toBe('ban');
    await bob.get(`/api/groups/${g.id}/posts`).expect(403);
    await bob.get(`/api/groups/${ch.id}`).expect(404); // a channel is known only to those who read its group
    expect(((await bob.get('/api/groups?mine=true').expect(200)).body as { id: string }[]).map((x) => x.id)).not.toContain(g.id);
    expect((await bob.post(`/api/groups/${g.id}/join`).expect(403)).body).toMatchObject({ step: 'ban', kind: 'suspend' });
    const row = (await h.s.groups.row(h.tenantId, g.id))!;
    expect(await h.s.groups.membersWithAccess(row)).not.toContain(bob.user.id);
    // a moderator suspends members only; an owner suspends a moderator
    await bob.post(`/api/groups/${g.id}/bans`, { userId: carol.user.id, kind: 'suspend', days: 1 }).expect(403);
    await alice.post(`/api/groups/${g.id}/bans`, { userId: carol.user.id, kind: 'suspend', days: 1 }).expect(201);
    expect((await carol.get(`/api/groups/${g.id}/bans`).expect(403)).body.step).toBe('ban');

    // lifted: the membership is back as it was, with the channel
    expect((await alice.del(`/api/groups/${g.id}/bans/${sus.id}`).expect(200)).body.state).toBe('lifted');
    expect((await bob.get(`/api/groups/${g.id}`).expect(200)).body).toMatchObject({ role: 'member', standing: null });
    await bob.post(`/api/groups/${g.id}/posts`, { body: 'After' }).expect(201);
    await bob.get(`/api/groups/${ch.id}`).expect(200);
    expect((await notes(h, bob.user.id)).map((n) => n.title).join('|')).toMatch(/suspended from Press room until .*Your suspension from Press room was lifted/);

    // a ban in the group removes the member from its channels too
    await alice.post(`/api/groups/${g.id}/bans`, { userId: bob.user.id, kind: 'ban', days: 1 }).expect(201);
    expect(await h.s.db('group_members').where({ user_id: bob.user.id }).whereIn('group_id', [g.id, ch.id])).toHaveLength(0);
  }, 120_000);

  it('B-9702: an invite link with a limit of 3 admits three people and refuses the fourth', async () => {
    const frank = await personIn(h, 'frank', []); // not in the workspace
    const g = (await alice.post('/api/groups', { workspaceId: ws, name: 'Inner circle', joinMode: 'invite', visibility: 'hidden' }).expect(201)).body;
    const link = (await alice.post(`/api/groups/${g.id}/invite-links`, { maxUses: 3, expiresInDays: 2 }).expect(201)).body;
    expect(link).toMatchObject({ maxUses: 3, uses: 0, remaining: 3, state: 'active' });
    expect(link.url).toContain(`#/groups?code=${link.code}`);
    // the code is shown once and kept as a digest
    const stored = await h.s.db('group_invite_links').where({ id: link.id }).first();
    expect(stored.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(normaliseCode(link.code)!);
    expect(stored.code_hint).toBe(normaliseCode(link.code)!.slice(-4));
    const listed = (await alice.get(`/api/groups/${g.id}/invite-links`).expect(200)).body;
    expect(listed).toEqual([expect.objectContaining({ id: link.id, hint: stored.code_hint, remaining: 3 })]);
    expect(JSON.stringify(listed)).not.toContain(link.code);

    // what a code leads to, for someone who could be admitted; nothing for a wrong code or an outsider
    expect((await bob.post('/api/group-invites/lookup', { code: link.code }).expect(200)).body).toMatchObject({ group: { id: g.id, name: 'Inner circle' }, state: 'active', remaining: 3, member: false });
    await bob.post('/api/group-invites/lookup', { code: newCode() }).expect(404);
    await frank.post('/api/group-invites/lookup', { code: link.code }).expect(404);
    await frank.post('/api/group-invites/redeem', { code: link.code }).expect(404);

    // three are admitted (the code read as typed), the fourth is refused
    expect((await bob.post('/api/group-invites/redeem', { code: link.code.toLowerCase().replace(/-/g, ' ') }).expect(200)).body).toMatchObject({ joined: true, role: 'member', groupId: g.id });
    await bob.post('/api/group-invites/redeem', { code: link.code }).expect(409); // already a member: no use taken
    await carol.post('/api/group-invites/redeem', { code: link.code }).expect(200);
    await dave.post('/api/group-invites/redeem', { code: link.code }).expect(200);
    const fourth = await erin.post('/api/group-invites/redeem', { code: link.code }).expect(410);
    expect(fourth.body).toMatchObject({ step: 'invite-link', state: 'used' });
    expect(await h.s.db('group_members').where({ group_id: g.id })).toHaveLength(4);
    expect((await h.s.db('group_invite_links').where({ id: link.id }).first()).uses).toBe(3);
    expect(await h.s.db('group_invite_uses').where({ link_id: link.id })).toHaveLength(3);
    expect((await alice.get(`/api/groups/${g.id}/invite-links`).expect(200)).body[0]).toMatchObject({ state: 'used', remaining: 0 });
    expect((await audits(h, 'group.member.joined')).map((a) => JSON.parse(a.detail!)).filter((d) => d.via === 'invite-link' && d.link === link.id)).toHaveLength(3);

    // a member makes no links and reads none
    await bob.post(`/api/groups/${g.id}/invite-links`, {}).expect(403);
    await bob.get(`/api/groups/${g.id}/invite-links`).expect(403);

    // expired and withdrawn links admit nobody
    const second = (await alice.post(`/api/groups/${g.id}/invite-links`, {}).expect(201)).body;
    expect(second.maxUses).toBeNull();
    await h.s.db('group_invite_links').where({ id: second.id }).update({ expires_at: Date.now() - 1000 });
    expect((await erin.post('/api/group-invites/redeem', { code: second.code }).expect(410)).body.state).toBe('expired');
    const third = (await alice.post(`/api/groups/${g.id}/invite-links`, { maxUses: 5 }).expect(201)).body;
    expect((await alice.del(`/api/groups/${g.id}/invite-links/${third.id}`).expect(200)).body.state).toBe('revoked');
    expect((await erin.post('/api/group-invites/redeem', { code: third.code }).expect(410)).body.state).toBe('revoked');

    // a full group admits nobody by a link, and the link keeps its place
    const fourthLink = (await alice.post(`/api/groups/${g.id}/invite-links`, { maxUses: 1 }).expect(201)).body;
    await alice.patch(`/api/groups/${g.id}`, { memberLimit: 4 }).expect(200);
    expect((await erin.post('/api/group-invites/redeem', { code: fourthLink.code }).expect(409)).body.step).toBe('member-limit');
    expect((await h.s.db('group_invite_links').where({ id: fourthLink.id }).first()).uses).toBe(0);
    await alice.patch(`/api/groups/${g.id}`, { memberLimit: null }).expect(200);
    await erin.post('/api/group-invites/redeem', { code: fourthLink.code }).expect(200);
    expect(await audits(h, 'group.invite-link.created')).toHaveLength(4);
    expect(await audits(h, 'group.invite-link.revoked')).toHaveLength(1);
  }, 120_000);

  it('B-9702: a request and an invitation carry a message the guardrails screened', async () => {
    await rules(h, [NUKE, WIRE]);
    const g = (await alice.post('/api/groups', { workspaceId: ws, name: 'Letterpress', joinMode: 'request', visibility: 'private' }).expect(201)).body;

    // a blocked or held message is refused, and nothing is kept
    expect((await bob.post(`/api/groups/${g.id}/join`, { message: 'I have the launch codes' }).expect(422)).body).toMatchObject({ step: 'guardrails', action: 'block', field: 'message' });
    expect((await bob.post(`/api/groups/${g.id}/join`, { message: 'Send a wire transfer' }).expect(422)).body.action).toBe('require-approval');
    await bob.post(`/api/groups/${g.id}/join`, { message: 'x'.repeat(501) }).expect(400);
    expect(await h.s.db('group_requests').where({ group_id: g.id })).toHaveLength(0);

    // the request's message is sealed; the moderators and the requester read it
    const asked = (await bob.post(`/api/groups/${g.id}/join`, { message: 'I print broadsides at the weekend.' }).expect(202)).body.request;
    expect(asked.message).toBe('I print broadsides at the weekend.');
    const stored = await h.s.db('group_requests').where({ id: asked.id }).first();
    expect(stored.message).toBeTruthy();
    expect(stored.message).not.toContain('broadsides');
    expect((await alice.get(`/api/groups/${g.id}/requests`).expect(200)).body).toEqual([expect.objectContaining({ id: asked.id, message: 'I print broadsides at the weekend.' })]);
    expect((await bob.get('/api/group-requests').expect(200)).body).toEqual([expect.objectContaining({ id: asked.id, message: 'I print broadsides at the weekend.' })]);
    expect((await alice.post(`/api/group-requests/${asked.id}/accept`).expect(200)).body).toMatchObject({ state: 'accepted', message: 'I print broadsides at the weekend.' });
    // asking without a message works as before
    expect((await carol.post(`/api/groups/${g.id}/join`).expect(202)).body.request.message).toBeNull();

    // an invitation's message reaches the invitee
    await alice.post(`/api/groups/${g.id}/invites`, { userId: dave.user.id, message: 'Bring the launch codes' }).expect(422);
    const inv = (await alice.post(`/api/groups/${g.id}/invites`, { userId: dave.user.id, message: 'We meet on Thursdays.' }).expect(201)).body;
    expect(inv).toMatchObject({ kind: 'invite', message: 'We meet on Thursdays.' });
    expect((await dave.get('/api/group-requests').expect(200)).body).toEqual([expect.objectContaining({ id: inv.id, message: 'We meet on Thursdays.' })]);
    expect((await h.s.db('group_requests').where({ id: inv.id }).first()).message).not.toContain('Thursdays');
    const made = (await audits(h, 'group.invite.created')).map((a) => JSON.parse(a.detail!));
    expect(made).toEqual([expect.objectContaining({ message: true })]);
    expect(JSON.stringify(made)).not.toContain('Thursdays');
  }, 120_000);
});
