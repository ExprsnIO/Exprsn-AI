/*
 * 1.9.0, Sprint 53 (B-175): counting the ballots of a group proposal. Pure functions, no database: the proposal service
 * hands them the choices (never who made them) and records what they return, the tally and the working, in the audit
 * chain and on the proposal.
 *
 * Methods:
 *
 * - `majority`: yes, no or abstain. Passes when there are more yes than no; abstentions count for the quorum only. A
 *   tie does not pass.
 * - `supermajority`: as majority, but yes must be at least the fraction (two thirds unless the group set another) of
 *   yes and no together: yes × den ≥ num × (yes + no), in integers, so 2 of 3 is exactly two thirds.
 * - `approval`: each ballot approves any number of the options; the option with the most approvals wins. A tie at the
 *   top goes to the option listed first in the proposal, and the working says so.
 * - `ranked`: each ballot ranks some or all of the options; instant runoff. Each round counts every ballot for its
 *   highest-ranked option still in the count. An option with more than half of the ballots still counting wins;
 *   otherwise the option with the fewest votes is eliminated and its ballots move on (a ballot with no option left is
 *   exhausted). A tie for the fewest is broken by the earlier rounds, most recent first (the option with fewer votes
 *   there goes); an option tied in every round so far goes in the reverse of the proposal's order (the one listed
 *   last). Every break is written into the round as plain text.
 *
 * Quorum: `share` is a percentage of the electorate (rounded up to whole ballots), `count` a number of ballots; every
 * ballot counts towards it, abstentions and empty approval ballots included.
 */

export const METHODS = ['majority', 'supermajority', 'approval', 'ranked'] as const;
export type Method = (typeof METHODS)[number];
export const YES_NO = ['yes', 'no', 'abstain'] as const;
export type YesNo = (typeof YES_NO)[number];
export const QUORUM_KINDS = ['none', 'share', 'count'] as const;
export type QuorumKind = (typeof QUORUM_KINDS)[number];

/** A ballot's choice: one of yes/no/abstain, or a list of option ids (approved, or ranked best first). */
export type Choice = YesNo | string[];

export interface Quorum {
  kind: QuorumKind;
  value: number;
}

export interface Round {
  round: number;
  counts: Record<string, number>;
  exhausted: number;
  /** What happened at the end of the round, in plain words. */
  note: string;
  eliminated?: string;
  winner?: string;
}

export interface Tally {
  method: Method;
  ballots: number;
  electorate: number;
  quorum: { kind: QuorumKind; value: number; required: number; met: boolean };
  /** yes/no/abstain counts, or approvals per option. Ranked choice: first preferences. */
  counts: Record<string, number>;
  threshold?: { num: number; den: number };
  rounds?: Round[];
  outcome: 'passed' | 'rejected' | 'no_quorum';
  winner?: string | null;
  /** The method's working in a sentence or two. */
  explanation: string;
}

export function quorumRequired(q: Quorum, electorate: number): number {
  if (q.kind === 'count') return Math.max(0, Math.floor(q.value));
  if (q.kind === 'share') return Math.ceil((electorate * Math.max(0, Math.min(100, q.value))) / 100);
  return 0;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function tally(input: { method: Method; options: string[]; choices: Choice[]; electorate: number; quorum: Quorum; threshold?: { num: number; den: number } }): Tally {
  const { method, options, choices, electorate } = input;
  const required = quorumRequired(input.quorum, electorate);
  const quorum = { kind: input.quorum.kind, value: input.quorum.value, required, met: choices.length >= required };
  const base = { method, ballots: choices.length, electorate, quorum };
  if (method === 'majority' || method === 'supermajority') {
    const counts: Record<string, number> = { yes: 0, no: 0, abstain: 0 };
    for (const c of choices) if (typeof c === 'string' && c in counts) counts[c]!++;
    const yes = counts.yes!;
    const no = counts.no!;
    const threshold = method === 'supermajority' ? (input.threshold ?? { num: 2, den: 3 }) : undefined;
    if (!quorum.met) return { ...base, counts, ...(threshold ? { threshold } : {}), outcome: 'no_quorum', explanation: `${plural(choices.length, 'ballot')} of the ${required} the quorum needs; the proposal is not decided.` };
    if (threshold) {
      const passed = yes + no > 0 && yes * threshold.den >= threshold.num * (yes + no);
      return { ...base, counts, threshold, outcome: passed ? 'passed' : 'rejected', explanation: `${yes} yes of ${yes + no} yes and no (${plural(counts.abstain!, 'abstention')} not counted); ${passed ? 'at least' : 'below'} the ${threshold.num}/${threshold.den} needed.` };
    }
    const passed = yes > no;
    return { ...base, counts, outcome: passed ? 'passed' : 'rejected', explanation: yes === no ? `${yes} yes and ${no} no: a tie does not pass.` : `${yes} yes and ${no} no (${plural(counts.abstain!, 'abstention')} not counted): ${passed ? 'more yes than no' : 'not more yes than no'}.` };
  }
  if (method === 'approval') {
    const counts: Record<string, number> = Object.fromEntries(options.map((o) => [o, 0]));
    for (const c of choices) if (Array.isArray(c)) for (const o of new Set(c)) if (o in counts) counts[o]!++;
    if (!quorum.met) return { ...base, counts, outcome: 'no_quorum', winner: null, explanation: `${plural(choices.length, 'ballot')} of the ${required} the quorum needs; no option is chosen.` };
    const top = Math.max(0, ...Object.values(counts));
    if (top === 0) return { ...base, counts, outcome: 'rejected', winner: null, explanation: 'No option was approved on any ballot.' };
    const tied = options.filter((o) => counts[o] === top);
    const winner = tied[0]!;
    return { ...base, counts, outcome: 'passed', winner, explanation: tied.length > 1 ? `${tied.join(', ')} tied with ${plural(top, 'approval')}; ${winner} is listed first in the proposal and wins.` : `${winner} has the most approvals (${top}).` };
  }
  // ranked choice, instant runoff
  const ballots = choices.filter(Array.isArray).map((c) => [...new Set(c)].filter((o) => options.includes(o)));
  const firsts: Record<string, number> = Object.fromEntries(options.map((o) => [o, 0]));
  for (const b of ballots) if (b[0]) firsts[b[0]]!++;
  if (!quorum.met) return { ...base, counts: firsts, outcome: 'no_quorum', winner: null, rounds: [], explanation: `${plural(choices.length, 'ballot')} of the ${required} the quorum needs; no option is chosen.` };
  const continuing = new Set(options);
  const rounds: Round[] = [];
  for (let n = 1; n <= options.length; n++) {
    const counts: Record<string, number> = Object.fromEntries([...continuing].map((o) => [o, 0]));
    let exhausted = 0;
    for (const b of ballots) {
      const pick = b.find((o) => continuing.has(o));
      if (pick) counts[pick]!++;
      else exhausted++;
    }
    const active = ballots.length - exhausted;
    if (active === 0) {
      rounds.push({ round: n, counts, exhausted, note: 'No ballot ranks an option still in the count.' });
      return { ...base, counts: firsts, rounds, outcome: 'rejected', winner: null, explanation: 'No ballot ranked any option; no option is chosen.' };
    }
    const ordered = options.filter((o) => continuing.has(o));
    const top = Math.max(...ordered.map((o) => counts[o]!));
    const leader = ordered.find((o) => counts[o] === top)!;
    if (top * 2 > active || continuing.size === 1) {
      const note = continuing.size === 1 ? `${leader} is the only option left and wins.` : `${leader} has ${top} of ${active} ballots still counting, more than half, and wins.`;
      rounds.push({ round: n, counts, exhausted, note, winner: leader });
      return { ...base, counts: firsts, rounds, outcome: 'passed', winner: leader, explanation: `Instant runoff over ${plural(rounds.length, 'round')}: ${note}` };
    }
    const low = Math.min(...ordered.map((o) => counts[o]!));
    let tied = ordered.filter((o) => counts[o] === low);
    let note: string;
    if (tied.length === 1) note = `${tied[0]} has the fewest votes (${low}) and is eliminated.`;
    else {
      const first = [...tied];
      let decidedIn: number | null = null;
      for (let back = rounds.length - 1; back >= 0 && tied.length > 1; back--) {
        const before = rounds[back]!.counts;
        const least = Math.min(...tied.map((o) => before[o] ?? 0));
        const narrowed = tied.filter((o) => (before[o] ?? 0) === least);
        if (narrowed.length < tied.length) decidedIn = rounds[back]!.round;
        tied = narrowed;
      }
      if (tied.length === 1) note = `${first.join(', ')} tied on ${plural(low, 'vote')}; ${tied[0]} had fewer votes in round ${decidedIn} and is eliminated.`;
      else {
        tied = [tied[tied.length - 1]!];
        note = `${first.join(', ')} tied on ${plural(low, 'vote')}${rounds.length ? ' here and in every earlier round' : ''}; ${tied[0]} is listed last in the proposal and is eliminated.`;
      }
    }
    const out = tied[0]!;
    continuing.delete(out);
    rounds.push({ round: n, counts, exhausted, note, eliminated: out });
  }
  return { ...base, counts: firsts, rounds, outcome: 'rejected', winner: null, explanation: 'No option won.' };
}

/** A valid choice for the method and options, or a reason it is not. */
export function checkChoice(method: Method, options: string[], c: unknown): { ok: true; choice: Choice } | { ok: false; why: string } {
  if (method === 'majority' || method === 'supermajority') {
    return typeof c === 'string' && (YES_NO as readonly string[]).includes(c) ? { ok: true, choice: c as YesNo } : { ok: false, why: 'Vote yes, no or abstain.' };
  }
  if (!Array.isArray(c) || !c.every((x) => typeof x === 'string')) return { ok: false, why: method === 'approval' ? 'Name the options you approve.' : 'Rank the options, best first.' };
  const list = c as string[];
  if (new Set(list).size !== list.length) return { ok: false, why: 'Name each option once.' };
  const bad = list.filter((o) => !options.includes(o));
  if (bad.length) return { ok: false, why: `Not an option of this proposal: ${bad.join(', ')}.` };
  if (method === 'ranked' && !list.length) return { ok: false, why: 'Rank at least one option.' };
  return { ok: true, choice: list };
}

/** The canonical text of a choice, for the commitment and the published list. */
export const choiceText = (c: Choice): string => (Array.isArray(c) ? JSON.stringify(c) : c);
export const choiceFrom = (v: string): Choice => (v.startsWith('[') ? (JSON.parse(v) as string[]) : (v as YesNo));
