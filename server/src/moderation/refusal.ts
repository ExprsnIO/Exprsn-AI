import { HttpProblem } from '../http/problem.js';

/** The sanction that keeps a user out (B-1904), as cached: its id, kind and end (null: until lifted). */
export interface Blocking {
  id: string;
  kind: 'suspend' | 'ban';
  endsAt: number | null;
}

/** The refusal for a sanctioned user: 403 with the sanction and its end, at sign-in and on every request. */
export function sanctionRefusal(b: Blocking): HttpProblem {
  const until = b.endsAt ? new Date(b.endsAt).toISOString() : null;
  return new HttpProblem(403, b.kind === 'ban' ? 'Account banned' : 'Account suspended', b.kind === 'ban' ? `This account is banned${until ? ` until ${until}` : ''}.` : `This account is suspended until ${until}.`, { extensions: { step: 'sanction', sanction: b.kind, until } });
}
