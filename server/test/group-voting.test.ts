import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tally, type Choice } from '../src/groups/tally.js';
import { audits, club, expire, world, type Person, type World } from './group-governance-helpers.js';

/*
 * 1.9.0, Sprint 53 (B-175): voting on group proposals. Each method with its exact result, ranked choice with ties
 * broken as documented, quorum, the electorate fixed at opening, changing a vote, secret ballots (no voter beside a
 * choice anywhere in the database; receipts found in the commitments published at close) and the tally with its
 * working in the audit chain.
 */

describe('tallying (pure)', () => {
  const q0 = { kind: 'none' as const, value: 0 };
  it('majority and supermajority count yes against no, abstentions aside', () => {
    expect(tally({ method: 'majority', options: [], choices: ['yes', 'yes', 'no', 'abstain', 'abstain'], electorate: 5, quorum: q0 })).toMatchObject({ outcome: 'passed', counts: { yes: 2, no: 1, abstain: 2 }, ballots: 5 });
    expect(tally({ method: 'majority', options: [], choices: ['yes', 'no'], electorate: 2, quorum: q0 })).toMatchObject({ outcome: 'rejected', explanation: '1 yes and 1 no: a tie does not pass.' });
    // exactly two thirds passes a two-thirds supermajority; a hair less does not
    expect(tally({ method: 'supermajority', options: [], choices: ['yes', 'yes', 'no', 'abstain'], electorate: 4, quorum: q0 }).outcome).toBe('passed');
    expect(tally({ method: 'supermajority', options: [], choices: ['yes', 'yes', 'no', 'no', 'yes', 'yes', 'no'], electorate: 7, quorum: q0 }).outcome).toBe('rejected');
    expect(tally({ method: 'supermajority', options: [], choices: ['yes', 'yes', 'yes', 'no'], electorate: 4, quorum: q0, threshold: { num: 3, den: 4 } }).outcome).toBe('passed');
    expect(tally({ method: 'supermajority', options: [], choices: ['yes', 'yes', 'no'], electorate: 3, quorum: q0, threshold: { num: 3, den: 4 } }).outcome).toBe('rejected');
  });

  it('approval: most approvals wins; a tie goes to the option listed first', () => {
    const t = tally({ method: 'approval', options: ['o1', 'o2', 'o3'], choices: [['o1', 'o2'], ['o2'], ['o3', 'o1'], []], electorate: 4, quorum: q0 });
    expect(t).toMatchObject({ outcome: 'passed', counts: { o1: 2, o2: 2, o3: 1 }, winner: 'o1', explanation: 'o1, o2 tied with 2 approvals; o1 is listed first in the proposal and wins.' });
  });

  it('ranked choice: instant runoff with its rounds', () => {
    // 9 ballots: A 4, B 3, C 2 first; C goes, its ballots split to B, so B wins in round 2 with 5 of 9.
    const ballots: Choice[] = [['A'], ['A'], ['A'], ['A', 'C'], ['B'], ['B'], ['B', 'A'], ['C', 'B'], ['C', 'B']];
    const t = tally({ method: 'ranked', options: ['A', 'B', 'C'], choices: ballots, electorate: 9, quorum: q0 });
    expect(t.outcome).toBe('passed');
    expect(t.winner).toBe('B');
    expect(t.rounds).toEqual([
      { round: 1, counts: { A: 4, B: 3, C: 2 }, exhausted: 0, note: 'C has the fewest votes (2) and is eliminated.', eliminated: 'C' },
      { round: 2, counts: { A: 4, B: 5 }, exhausted: 0, note: 'B has 5 of 9 ballots still counting, more than half, and wins.', winner: 'B' }
    ]);
  });

  it('ranked choice ties: broken by earlier rounds, then by the proposal’s order', () => {
    // Round 1: A 3, B 2, C 2, D 1 → D goes (its ballot moves to C). Round 2: A 3, B 2, C 3 → B goes (its two ballots
    // rank nothing else and are exhausted). Round 3: A 3, C 3 tie; in round 2 they tied too, in round 1 C had fewer: C
    // goes, and A, alone, wins.
    const t1 = tally({ method: 'ranked', options: ['A', 'B', 'C', 'D'], choices: [['A'], ['A'], ['A'], ['B'], ['B'], ['C', 'B'], ['C', 'B'], ['D', 'C']], electorate: 8, quorum: q0 });
    expect(t1.rounds!.map((r) => r.eliminated ?? r.winner)).toEqual(['D', 'B', 'C', 'A']);
    expect(t1.rounds![2]!.note).toBe('A, C tied on 3 votes; C had fewer votes in round 1 and is eliminated.');
    // A tie for last decided by an earlier round: round 1 A 3, B 2, C 2, D 2 → three tied, B, C, D; listed last (D) goes.
    // Round 2: D's ballot goes to B: A 3, B 3, C 2 → C goes. Round 3: C's ballots go to A: A 5, B 3 → A.
    const t2 = tally({ method: 'ranked', options: ['A', 'B', 'C', 'D'], choices: [['A'], ['A'], ['A'], ['B'], ['B'], ['C', 'A'], ['C', 'A'], ['D', 'B'], ['D']], electorate: 9, quorum: q0 });
    expect(t2.rounds![0]).toMatchObject({ eliminated: 'D', note: 'B, C, D tied on 2 votes; D is listed last in the proposal and is eliminated.' });
    expect(t2.rounds![1]).toMatchObject({ counts: { A: 3, B: 3, C: 2 }, eliminated: 'C', exhausted: 1 });
    expect(t2.winner).toBe('A');
    // A tie broken by the round before: round 1 A 4, B 3, C 2, D 1 (D goes, to C); round 2 A 4, B 3, C 3: B and C tie,
    // C had fewer in round 1, so C goes.
    const t3 = tally({ method: 'ranked', options: ['A', 'B', 'C', 'D'], choices: [['A'], ['A'], ['A'], ['A'], ['B'], ['B'], ['B'], ['C'], ['C'], ['D', 'C']], electorate: 10, quorum: q0 });
    expect(t3.rounds![1]).toMatchObject({ counts: { A: 4, B: 3, C: 3 }, eliminated: 'C', note: 'B, C tied on 3 votes; C had fewer votes in round 1 and is eliminated.' });
    // Two left and tied in every round: the one listed last goes, the other wins.
    const t4 = tally({ method: 'ranked', options: ['A', 'B'], choices: [['A'], ['B']], electorate: 2, quorum: q0 });
    expect(t4).toMatchObject({ winner: 'A', outcome: 'passed' });
    expect(t4.rounds![0]!.note).toBe('A, B tied on 1 vote; B is listed last in the proposal and is eliminated.');
  });

  it('quorum: a share of the electorate, rounded up, or a number', () => {
    expect(tally({ method: 'majority', options: [], choices: ['yes', 'yes'], electorate: 5, quorum: { kind: 'share', value: 50 } })).toMatchObject({ outcome: 'no_quorum', quorum: { required: 3, met: false } });
    expect(tally({ method: 'majority', options: [], choices: ['yes', 'abstain', 'abstain'], electorate: 5, quorum: { kind: 'share', value: 50 } })).toMatchObject({ outcome: 'passed', quorum: { required: 3, met: true } });
    expect(tally({ method: 'majority', options: [], choices: ['yes'], electorate: 5, quorum: { kind: 'count', value: 2 } }).outcome).toBe('no_quorum');
  });
});

describe('group voting (B-175)', () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  }, 120_000);
  afterEach(async () => {
    await w.h.close();
  });

  async function propose(by: Person, groupId: string, body: Record<string, unknown>) {
    const pr = (await by.post(`/api/groups/${groupId}/proposals`, { kind: 'free', title: 'A question', ...body }).expect(201)).body as { id: string };
    await by.post(`/api/group-proposals/${pr.id}/open`).expect(200);
    return pr.id;
  }
  const vote = (x: Person, id: string, choice: unknown, extra: object = {}) => x.post(`/api/group-proposals/${id}/ballots`, { choice, ...extra });

  it('each method through the API, with exact results recorded in the audit chain', async () => {
    const { h, alice, bob, carol, dave, erin } = w;
    const g = await club(w, [bob, carol, dave, erin]);
    const everyone = [alice, bob, carol, dave, erin];
    // majority 3 yes, 1 no, 1 abstain
    const m = await propose(bob, g.id, {});
    for (const [x, c] of [[alice, 'yes'], [bob, 'yes'], [carol, 'yes'], [dave, 'no'], [erin, 'abstain']] as const) await vote(x, m, c).expect(200);
    // supermajority 3/4: 3 yes and 2 no is 60%, short of it
    const sm = await propose(bob, g.id, { method: 'supermajority', threshold: { num: 3, den: 4 } });
    for (const [x, c] of [[alice, 'yes'], [bob, 'yes'], [carol, 'yes'], [dave, 'no'], [erin, 'no']] as const) await vote(x, sm, c).expect(200);
    // approval
    const ap = await propose(bob, g.id, { method: 'approval', options: ['Tomatoes', 'Beans', 'Kale'] });
    for (const [x, c] of [[alice, ['o1', 'o3']], [bob, ['o3']], [carol, ['o2', 'o3']], [dave, []], [erin, ['o1']]] as const) await vote(x, ap, c).expect(200);
    await vote(alice, ap, ['o4']).expect(422);
    await vote(alice, ap, 'yes').expect(422);
    // ranked choice: o1 2, o2 2, o3 1 first; o3 goes to o2; o2 wins 3 of 5
    const rc = await propose(bob, g.id, { method: 'ranked', options: ['North', 'South', 'East'] });
    for (const [x, c] of [[alice, ['o1']], [bob, ['o1', 'o2']], [carol, ['o2']], [dave, ['o2', 'o1']], [erin, ['o3', 'o2']]] as const) await vote(x, rc, c).expect(200);
    await vote(alice, rc, []).expect(422);
    for (const id of [m, sm, ap, rc]) await expire(h, id);
    expect(await h.s.groupGovernance.tick(h.tenantId)).toMatchObject({ closed: 4 });

    const got = async (id: string) => (await alice.get(`/api/group-proposals/${id}`).expect(200)).body;
    expect((await got(m)).result).toMatchObject({ method: 'majority', outcome: 'passed', counts: { yes: 3, no: 1, abstain: 1 }, ballots: 5, electorate: 5 });
    expect((await got(sm)).result).toMatchObject({ outcome: 'rejected', counts: { yes: 3, no: 2 }, threshold: { num: 3, den: 4 } });
    expect((await got(ap)).result).toMatchObject({ outcome: 'passed', winner: 'o3', counts: { o1: 2, o2: 1, o3: 3 } });
    const ranked = (await got(rc)).result;
    expect(ranked).toMatchObject({ outcome: 'passed', winner: 'o2' });
    expect(ranked.rounds).toEqual([
      { round: 1, counts: { o1: 2, o2: 2, o3: 1 }, exhausted: 0, note: 'o3 has the fewest votes (1) and is eliminated.', eliminated: 'o3' },
      { round: 2, counts: { o1: 2, o2: 3 }, exhausted: 0, note: 'o2 has 3 of 5 ballots still counting, more than half, and wins.', winner: 'o2' }
    ]);
    // public ballots: members see who voted for what
    expect((await got(m)).ballots.map((b: { name: string; choice: string }) => `${b.name}:${b.choice}`).sort()).toEqual(['ALICE:yes', 'BOB:yes', 'CAROL:yes', 'DAVE:no', 'ERIN:abstain']);
    // the audit chain has the tallies and the working
    const closed = await audits(h, 'group.proposal.closed');
    expect(closed).toHaveLength(4);
    const byId = new Map(closed.map((e) => [e.target!.proposal as string, e.detail!]));
    expect(byId.get(m)).toMatchObject({ method: 'majority', outcome: 'passed', counts: { yes: 3, no: 1, abstain: 1 }, electorate: 5, turnout: 5, quorum: { kind: 'none', required: 0, met: true } });
    expect(byId.get(sm)).toMatchObject({ outcome: 'rejected', threshold: { num: 3, den: 4 } });
    expect(byId.get(rc)).toMatchObject({ winner: 'o2', rounds: ranked.rounds });
    expect(closed[0]!.actor).toEqual({ service: 'groups.governance' });
    // and nothing of the options' text
    expect(JSON.stringify(closed)).not.toMatch(/North|Tomatoes/);
    void everyone;
  });

  it('ranked choice ties through the API are broken as explained', async () => {
    const { h, alice, bob, carol, dave } = w;
    const g = await club(w, [bob, carol, dave]);
    const id = await propose(bob, g.id, { method: 'ranked', options: ['A', 'B', 'C'] });
    // o1 2, o2 1, o3 1: o2 and o3 tie in round 1; o3 is listed last and goes; its ballot moves to o2: o1 2, o2 2;
    // tied again, and in round 1 o1 had more, so o2 goes; o1 wins.
    for (const [x, c] of [[alice, ['o1']], [bob, ['o1']], [carol, ['o2']], [dave, ['o3', 'o2']]] as const) await vote(x, id, c).expect(200);
    await expire(h, id);
    const r = (await alice.get(`/api/group-proposals/${id}`).expect(200)).body.result;
    expect(r.rounds.map((x: { note: string }) => x.note)).toEqual([
      'o2, o3 tied on 1 vote; o3 is listed last in the proposal and is eliminated.',
      'o1, o2 tied on 2 votes; o2 had fewer votes in round 1 and is eliminated.',
      'o1 is the only option left and wins.'
    ]);
    expect(r.winner).toBe('o1');
  });

  it('quorum: without enough ballots the proposal is not decided', async () => {
    const { h, alice, bob, carol, dave, erin } = w;
    const g = await club(w, [bob, carol, dave, erin]);
    const share = await propose(bob, g.id, { quorum: { kind: 'share', value: 60 } });
    await vote(alice, share, 'yes').expect(200);
    await vote(bob, share, 'yes').expect(200);
    const count = await propose(bob, g.id, { quorum: { kind: 'count', value: 2 } });
    await vote(alice, count, 'yes').expect(200);
    await vote(carol, count, 'abstain').expect(200);
    await expire(h, share);
    await expire(h, count);
    const a = (await alice.get(`/api/group-proposals/${share}`).expect(200)).body;
    expect(a).toMatchObject({ state: 'closed', outcome: 'no_quorum', result: { quorum: { kind: 'share', value: 60, required: 3, met: false } } });
    expect((await alice.get(`/api/group-proposals/${count}`).expect(200)).body).toMatchObject({ outcome: 'passed', result: { quorum: { required: 2, met: true } } });
    void dave;
    void erin;
  });

  it('fixes the electorate when voting opens and lets a vote change until close', async () => {
    const { h, alice, bob, carol, erin } = w;
    const g = await club(w, [bob, carol]);
    const id = await propose(bob, g.id, {});
    // Erin joins after voting opened: a member now, but not of the electorate
    await erin.post(`/api/groups/${g.id}/join`).expect(200);
    expect((await vote(erin, id, 'yes').expect(403)).body.step).toBe('electorate');
    expect((await erin.get(`/api/group-proposals/${id}`).expect(200)).body).toMatchObject({ electorate: 3, mine: { eligible: false }, can: { vote: false } });
    // a change of vote replaces the ballot
    await vote(carol, id, 'yes').expect(200);
    expect((await vote(carol, id, 'no').expect(200)).body).toMatchObject({ changed: true, choice: 'no' });
    await vote(alice, id, 'no').expect(200);
    await vote(bob, id, 'yes').expect(200);
    expect(await h.s.db('group_ballots').where({ proposal_id: id })).toHaveLength(3);
    expect((await alice.get(`/api/group-proposals/${id}`).expect(200)).body.turnout).toBe(3);
    await expire(h, id);
    expect((await alice.get(`/api/group-proposals/${id}`).expect(200)).body.result).toMatchObject({ outcome: 'rejected', counts: { yes: 1, no: 2 } });
    // after close nothing changes
    await vote(carol, id, 'yes').expect(409);
    expect((await audits(h, 'group.vote.changed')).map((e) => e.detail)).toEqual([{ secret: false, choice: 'no' }]);
  });

  it('secret ballots: no voter beside a choice anywhere, and receipts found in the published commitments', async () => {
    const { h, alice, bob, carol, dave } = w;
    const g = await club(w, [bob, carol, dave]);
    const id = await propose(bob, g.id, { secret: true, method: 'ranked', options: ['Red', 'Green', 'Blue'] });
    const choices: [Person, string[]][] = [[alice, ['o1', 'o2', 'o3']], [bob, ['o3', 'o1']], [carol, ['o2']], [dave, ['o2', 'o3']]];
    const receipts = new Map<string, { ballotId: string; choice: string[]; nonce: string; commitment: string; token: string }>();
    for (const [x, c] of choices) {
      const r = (await vote(x, id, c).expect(200)).body;
      expect(r).toMatchObject({ secret: true, changed: false, receipt: { proposalId: id, choice: c } });
      receipts.set(x.user.id, r.receipt);
    }
    // a second vote without the receipt is refused; with someone else's token too
    expect((await vote(dave, id, ['o3']).expect(409)).body.step).toBe('receipt');
    const daveR = receipts.get(dave.user.id)!;
    await vote(dave, id, ['o3'], { ballotId: daveR.ballotId, token: receipts.get(carol.user.id)!.token }).expect(403);
    // with it, the ballot changes (a new commitment)
    const changed = (await vote(dave, id, ['o3', 'o2'], { ballotId: daveR.ballotId, token: daveR.token }).expect(200)).body;
    expect(changed).toMatchObject({ changed: true, receipt: { ballotId: daveR.ballotId, choice: ['o3', 'o2'] } });
    expect(changed.receipt.commitment).not.toBe(daveR.commitment);
    receipts.set(dave.user.id, changed.receipt);
    // members see how many voted, not how
    const open = (await carol.get(`/api/group-proposals/${id}`).expect(200)).body;
    expect(open).toMatchObject({ turnout: 4, mine: { voted: true, choice: null } });
    expect(open.ballots).toBeUndefined();
    expect(open.commitments).toBeUndefined();

    const scan = async () => {
      const tables = ((await h.s.db.raw("select name from sqlite_master where type = 'table'")) as { name: string }[]).map((t) => t.name);
      const hits: string[] = [];
      for (const t of tables) {
        const rows = (await h.s.db(t).select('*')) as Record<string, unknown>[];
        for (const row of rows) {
          const text = JSON.stringify(row);
          for (const [x] of choices) {
            const r = receipts.get(x.user.id)!;
            if (!text.includes(x.user.id)) continue;
            for (const secret of [JSON.stringify(r.choice), r.ballotId, r.commitment, r.nonce]) if (text.includes(secret)) hits.push(`${t}: ${x.user.id} with ${secret}`);
          }
        }
      }
      return hits;
    };
    expect(await scan()).toEqual([]);
    // the ballot rows carry no voter and no time; participation carries nothing about how
    const ballots = (await h.s.db('group_ballots').where({ proposal_id: id })) as Record<string, unknown>[];
    expect(ballots).toHaveLength(4);
    for (const b of ballots) expect(b).toMatchObject({ voter_id: null, voted_at: null });
    expect(Object.keys((await h.s.db('group_vote_participation').where({ proposal_id: id }).first())!).sort()).toEqual(['proposal_id', 'tenant_id', 'user_id']);
    // the audit entries record participation only
    for (const e of [...(await audits(h, 'group.vote.cast')), ...(await audits(h, 'group.vote.changed'))]) expect(e.detail).toEqual({ secret: true });

    await expire(h, id);
    const closed = (await alice.get(`/api/group-proposals/${id}`).expect(200)).body;
    expect(closed.state).toBe('closed');
    expect(closed.commitments).toHaveLength(4);
    // each voter finds their receipt in the published list with their choice, and the list adds up to the tally
    for (const [x] of choices) {
      const r = receipts.get(x.user.id)!;
      expect(closed.commitments).toContainEqual({ commitment: r.commitment, choice: r.choice });
      expect((await x.post(`/api/group-proposals/${id}/verify-receipt`, { commitment: r.commitment, choice: r.choice }).expect(200)).body).toMatchObject({ published: true, counted: true });
    }
    expect((await alice.post(`/api/group-proposals/${id}/verify-receipt`, { commitment: daveR.commitment, choice: daveR.choice }).expect(200)).body).toMatchObject({ counted: false });
    const recount = tally({ method: 'ranked', options: ['o1', 'o2', 'o3'], choices: closed.commitments.map((c: { choice: string[] }) => c.choice), electorate: 4, quorum: { kind: 'none', value: 0 } });
    expect(recount.rounds).toEqual(closed.result.rounds);
    const audit = (await audits(h, 'group.proposal.closed'))[0]!.detail!;
    expect(audit).toMatchObject({ secret: true, commitments: 4, commitmentsDigest: closed.commitmentsDigest });
    // after close the change tokens' digests are gone, and still no voter sits beside a choice
    expect((await h.s.db('group_ballots').where({ proposal_id: id }).whereNotNull('change_hash')).length).toBe(0);
    expect(await scan()).toEqual([]);
  });

  it('tells the electorate when voting opens, before it closes and of the result, as their preferences say', async () => {
    const { h, alice, bob, carol, dave } = w;
    const g = await club(w, [bob, carol, dave]);
    // Dave turned group decisions off in the console
    await dave.put('/api/me/notification-preferences', { kinds: { 'group.governance': { in_app: { enabled: false, timing: 'instant' } } } }).expect(200);
    const titles = async (x: Person) => ((await h.s.db('notifications').where({ user_id: x.user.id, kind: 'group.governance' }).orderBy('created_at')) as { title: string; label: string }[]).map((n) => n.title);
    const id = await propose(bob, g.id, { hours: 72 });
    expect(await titles(alice)).toEqual(['Voting is open on a proposal in Garden club']);
    expect(await titles(bob)).toEqual([]);
    expect(await titles(dave)).toEqual([]);
    // a reminder near the close, once, to those who have not voted
    await vote(alice, id, 'yes').expect(200);
    await h.s.db('group_proposals').where({ id }).update({ opens_at: Date.now() - 71 * 3_600_000, closes_at: Date.now() + 3_600_000 });
    expect(await h.s.groupGovernance.tick(h.tenantId)).toEqual({ closed: 0, reminded: 1 });
    expect(await h.s.groupGovernance.tick(h.tenantId)).toEqual({ closed: 0, reminded: 0 });
    expect(await titles(carol)).toEqual(['Voting is open on a proposal in Garden club', 'Voting on a proposal in Garden club closes soon']);
    expect(await titles(alice)).toEqual(['Voting is open on a proposal in Garden club']);
    await expire(h, id);
    expect(await h.s.groupGovernance.tick(h.tenantId)).toMatchObject({ closed: 1 });
    expect((await titles(carol)).at(-1)).toBe('A vote in Garden club closed: passed');
    expect((await titles(bob)).at(-1)).toBe('A vote in Garden club closed: passed');
    expect(await titles(dave)).toEqual([]);
    // the notices carry the group's label and never the proposal's text
    const rows = (await h.s.db('notifications').where({ kind: 'group.governance' })) as { title: string; body: string | null; route: string }[];
    for (const r of rows) expect(`${r.title} ${r.body ?? ''}`).not.toContain('A question');
    expect(rows[0]!.route).toBe(`groups?id=${g.id}&tab=proposals&proposal=${id}`);
  });
});
