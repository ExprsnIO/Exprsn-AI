import type { Principal } from '../authz/policy.js';
import type { WfGraph } from './graph.js';

/*
 * 1.8.0, Sprint 47 (B-137): step comments. A comment is a note on a step, kept in the draft graph
 * (`nodes[].comments`), so it travels with published versions and bundles. It is metadata: `validateGraph`, the
 * publish checks and the runners never read it.
 *
 * Authorship is the server's: when a draft is saved, a comment the stored draft did not have is stamped with the
 * saver (`by`, `byName`, `at`), and a comment it had keeps the author and time stored, whatever the client sent. A
 * new workflow (also one imported from a bundle or made from a template) keeps what its comments carry and stamps
 * those that carry no author.
 */
export function stampComments(before: WfGraph | null, next: WfGraph, p: Principal, now = Date.now()): WfGraph {
  const known = new Map<string, { by?: string | undefined; byName?: string | undefined; at?: number | undefined }>();
  for (const n of before?.nodes ?? []) for (const c of n.comments ?? []) known.set(`${n.id}:${c.id}`, { by: c.by, byName: c.byName, at: c.at });
  const name = (p.displayName || p.username || '').slice(0, 200);
  for (const n of next.nodes) {
    if (!n.comments?.length) {
      if (n.comments) delete n.comments;
      continue;
    }
    for (const c of n.comments) {
      const was = known.get(`${n.id}:${c.id}`);
      if (was) {
        if (was.by) c.by = was.by;
        else delete c.by;
        if (was.byName) c.byName = was.byName;
        else delete c.byName;
        if (was.at != null) c.at = was.at;
        else delete c.at;
      } else if (before || !c.by) {
        c.by = p.userId;
        c.byName = name;
        c.at = now;
      }
    }
  }
  return next;
}
