import { json } from '../db/knex.js';
import { clears, type Label } from '../authz/labels.js';
import { effectivePermissions, type Principal } from '../authz/policy.js';
import { conflict, notFound } from '../http/problem.js';
import type { Services } from '../services.js';
import type { ChainKind } from './context.js';

/*
 * The chain view (B-4107) and the approvals held anywhere in a chain (B-4106).
 *
 * `GET /api/chains/:id` returns the tree of invocations from the root: each node's kind, what it called, timing, its
 * own usage (tokens, steps, wall time, GPU time as the cost meter) and its subtree's, its label, how it ended (with the
 * typed error its caller received), the guardrail decisions made in it, links to its run and its audit entries, how
 * it can be replayed, and the calls held in it. The usage of every node is charged to the root with the same atomic
 * increments as the node's own, so the tree's total equals what the chain metered (`totals` = `used`).
 *
 * A chain is visible to its principal and to agent, tool and workflow admins, within their clearance (the chain's
 * label is its high-water mark, so clearing it clears every node). A held call is decided where it waits (an agent
 * run's step, a workflow run's approval), with the same rules as there, from the root's view: the path shows where.
 */

type ViewNode = NonNullable<Awaited<ReturnType<Services['chains']['view']>>>['nodes'][number];

export interface HeldCall {
  node: string;
  path: { node: string; kind: ChainKind; ref: string; name: string | null; depth: number }[];
  at: { kind: 'agent-run'; run: string; step: number } | { kind: 'workflow-run'; run: string; approval: string; step: string };
  tool: string | null;
  sideEffect: string | null;
  since: number | null;
  approvers: string;
  canDecide: boolean;
}

const ADMIN = ['agents:manage', 'tools:manage', 'workflows:manage'] as const;

/** Whether `p` may see the chain at all (its principal, or an agent, tool or workflow admin), within clearance. */
export function mayView(p: Principal, c: { principal: string; label: Label }): boolean {
  if (!clears(p.clearance, c.label)) return false;
  if (c.principal === p.userId) return true;
  const perms = effectivePermissions(p);
  return ADMIN.some((x) => perms.has(x));
}

async function chainFor(s: Services, p: Principal, id: string) {
  const c = await s.chains.view(p.tenantId, id);
  if (!c) throw notFound('Chain');
  return c;
}

/** Names for nodes: an agent run's agent, a workflow run's workflow name, a tool's or skill's `name@version`. */
async function names(s: Services, tenantId: string, nodes: ViewNode[]): Promise<Map<string, string | null>> {
  const wfIds = [...new Set(nodes.filter((n) => n.kind === 'workflow-run' && n.callee).map((n) => n.callee!))];
  const wf = wfIds.length ? new Map(((await s.db('workflows').where({ tenant_id: tenantId }).whereIn('id', wfIds).select('id', 'name')) as { id: string; name: string }[]).map((w) => [w.id, w.name])) : new Map<string, string>();
  return new Map(nodes.map((n) => [n.id, n.kind === 'workflow-run' ? (wf.get(n.callee ?? '') ?? n.callee) : n.callee]));
}

/** Every call held in the chain: agent-run steps waiting on an approval and workflow approvals pending. */
export async function heldCalls(s: Services, p: Principal, chainId: string, nodes?: ViewNode[]): Promise<HeldCall[]> {
  const list = nodes ?? (await chainFor(s, p, chainId)).nodes;
  const named = await names(s, p.tenantId, list);
  const perms = effectivePermissions(p);
  const out: HeldCall[] = [];
  const pathOf = async (node: string) => (await s.chains.pathTo(chainId, node)).map((x) => ({ node: x.id, kind: x.kind, ref: x.ref, name: named.get(x.id) ?? x.callee, depth: x.depth }));
  for (const n of list.filter((x) => x.kind === 'agent-run' && x.state === 'waiting')) {
    const run = (await s.db('agent_runs').where({ tenant_id: p.tenantId, id: n.ref }).first('user_id', 'label', 'state')) as { user_id: string; label: Label; state: string } | undefined;
    if (!run || run.state !== 'waiting') continue;
    const steps = (await s.db('agent_steps').where({ run_id: n.ref, state: 'waiting' }).orderBy('n').select('n', 'title', 'meta')) as { n: number; title: string; meta: string }[];
    for (const st of steps) {
      const meta = json<Record<string, unknown>>(st.meta, {});
      if (meta.awaiting) continue; // waits on a child: the child's own hold is listed
      const side = String(meta.sideEffect ?? 'write');
      const toolAdmin = perms.has('tools:manage');
      const canDecide = clears(p.clearance, run.label) && (side === 'destructive' ? toolAdmin && run.user_id !== p.userId : run.user_id === p.userId || toolAdmin);
      out.push({ node: n.id, path: await pathOf(n.id), at: { kind: 'agent-run', run: n.ref, step: Number(st.n) }, tool: String(meta.tool ?? st.title), sideEffect: side, since: meta.waitingSince == null ? null : Number(meta.waitingSince), approvers: String(meta.approvers ?? (side === 'destructive' ? 'a tool admin other than the owner' : "the run's owner or a tool admin")), canDecide });
    }
  }
  for (const n of list.filter((x) => x.kind === 'workflow-run' && x.state === 'waiting')) {
    const run = (await s.db('workflow_runs').where({ tenant_id: p.tenantId, id: n.ref }).first('label', 'graph')) as { label: Label; graph: string } | undefined;
    if (!run) continue;
    const graph = json<{ nodes?: { id: string; title?: string }[] }>(run.graph, {});
    const approvals = (await s.db('workflow_approvals').where({ run_id: n.ref, state: 'pending' }).orderBy('created_at').select('id', 'node_id', 'role', 'shown', 'created_at')) as { id: string; node_id: string; role: string; shown: string | null; created_at: number }[];
    for (const a of approvals) {
      let shown: Record<string, unknown> = {};
      if (a.shown && clears(p.clearance, run.label)) {
        try {
          shown = json<Record<string, unknown>>(await s.keys.open(p.tenantId, a.shown, `wfapproval:${a.id}`), {});
        } catch {
          shown = {};
        }
      }
      const canDecide = clears(p.clearance, run.label) && (p.roles.includes(a.role) || p.roles.includes('system-admin'));
      out.push({ node: n.id, path: await pathOf(n.id), at: { kind: 'workflow-run', run: n.ref, approval: a.id, step: a.node_id }, tool: typeof shown.tool === 'string' ? shown.tool : (graph.nodes?.find((x) => x.id === a.node_id)?.title ?? a.node_id), sideEffect: typeof shown.sideEffect === 'string' ? shown.sideEffect : null, since: Number(a.created_at), approvers: `the ${a.role} role`, canDecide });
    }
  }
  return out;
}

/** The held calls of a run's chain when the run is its root and the viewer is cleared for the chain (else []). */
export async function rootHeld(s: Services, p: Principal, chain: { id: string; node: string | null } | null): Promise<HeldCall[]> {
  if (!chain?.node) return [];
  const c = await s.chains.view(p.tenantId, chain.id);
  if (!c || c.rootNode !== chain.node || !clears(p.clearance, c.label)) return [];
  return heldCalls(s, p, c.id, c.nodes);
}

/** The tree view of a chain. */
export async function chainTree(s: Services, p: Principal, id: string) {
  const c = await chainFor(s, p, id);
  if (!mayView(p, c)) throw notFound('Chain');
  const named = await names(s, p.tenantId, c.nodes);
  const perms = effectivePermissions(p);
  const auditor = perms.has('audit:read');

  // Guardrail decisions made in each run (agent runs by run id, workflow runs by their steps' ids).
  const agentRefs = c.nodes.filter((n) => n.kind === 'agent-run').map((n) => n.ref);
  const wfRefs = c.nodes.filter((n) => n.kind === 'workflow-run').map((n) => n.ref);
  const wfSteps = wfRefs.length ? ((await s.db('workflow_steps').whereIn('run_id', wfRefs).select('id', 'run_id')) as { id: string; run_id: string }[]) : [];
  const stepRun = new Map(wfSteps.map((x) => [x.id, x.run_id]));
  const decisions = new Map<string, { id: string; checkpoint: string; action: string; label: Label; at: number }[]>();
  const sources = [...agentRefs, ...wfSteps.map((x) => x.id)];
  for (let i = 0; i < sources.length; i += 500) {
    const rows = (await s.db('guard_decisions').where({ tenant_id: p.tenantId }).whereIn('source_kind', ['agent-run', 'workflow-step']).whereIn('source_id', sources.slice(i, i + 500)).orderBy('created_at').select('id', 'checkpoint', 'action', 'label', 'source_kind', 'source_id', 'created_at')) as { id: string; checkpoint: string; action: string; label: Label; source_kind: string; source_id: string; created_at: number }[];
    for (const r of rows) {
      const ref = r.source_kind === 'workflow-step' ? stepRun.get(r.source_id) : r.source_id;
      if (!ref) continue;
      const list = decisions.get(ref) ?? [];
      if (list.length < 50) list.push({ id: r.id, checkpoint: r.checkpoint, action: r.action, label: r.label, at: Number(r.created_at) });
      decisions.set(ref, list);
    }
  }

  // How each run can be replayed: an agent run from a step with a checkpoint before it, a workflow run from a step.
  const checkpoints = agentRefs.length ? ((await s.db('agent_checkpoints').whereIn('run_id', agentRefs).select('run_id', 'n')) as { run_id: string; n: number }[]) : [];
  const graphs = wfRefs.length ? ((await s.db('workflow_runs').whereIn('id', wfRefs).select('id', 'graph', 'mode')) as { id: string; graph: string; mode: string }[]) : [];

  const held = await heldCalls(s, p, c.id, c.nodes);
  const kids = new Map<string, ViewNode[]>();
  for (const n of c.nodes) if (n.parent) kids.set(n.parent, [...(kids.get(n.parent) ?? []), n]);

  const runLink = (n: ViewNode) => (n.kind === 'agent-run' ? `/api/runs/${n.ref}` : n.kind === 'workflow-run' ? `/api/workflow-runs/${n.ref}` : null);
  const replayOf = (n: ViewNode) => {
    if (n.kind === 'agent-run') {
      const steps = checkpoints.filter((x) => x.run_id === n.ref).map((x) => Number(x.n) + 1).sort((a, b) => a - b);
      return steps.length ? { href: `/api/chains/${c.id}/nodes/${n.id}/replay`, fromStep: steps } : null;
    }
    if (n.kind === 'workflow-run') {
      const g = graphs.find((x) => x.id === n.ref);
      const nodes = json<{ nodes?: { id: string; kind: string }[] }>(g?.graph ?? null, {}).nodes?.filter((x) => x.kind !== 'trigger').map((x) => x.id) ?? [];
      return nodes.length ? { href: `/api/chains/${c.id}/nodes/${n.id}/replay`, fromNode: nodes } : null;
    }
    return null;
  };

  const auditEntries = async (n: ViewNode) => (auditor && runLink(n) ? (await s.audit.list(p.tenantId, { target: n.ref, limit: 20 })).map((e) => ({ id: e.id, seq: e.seq, action: e.action, ts: e.ts })) : undefined);

  type TreeNode = Record<string, unknown> & { subtree: { tokens: number; steps: number; wallMs: number; gpuMs: number; nodes: number }; children: TreeNode[] };
  const build = async (n: ViewNode): Promise<TreeNode> => {
    const children = await Promise.all((kids.get(n.id) ?? []).map(build));
    const subtree = children.reduce((a, k) => ({ tokens: a.tokens + k.subtree.tokens, steps: a.steps + k.subtree.steps, wallMs: a.wallMs + k.subtree.wallMs, gpuMs: a.gpuMs + k.subtree.gpuMs, nodes: a.nodes + k.subtree.nodes }), { tokens: n.tokens, steps: n.steps, wallMs: n.wallMs, gpuMs: n.gpuMs, nodes: 1 });
    const entries = await auditEntries(n);
    return {
      id: n.id,
      parent: n.parent,
      depth: n.depth,
      kind: n.kind,
      ref: n.ref,
      callee: n.callee,
      name: named.get(n.id) ?? n.callee,
      label: n.label,
      state: n.state,
      error: n.error,
      errorType: n.errorType,
      decision: n.decision,
      usage: { tokens: n.tokens, steps: n.steps, wallMs: n.wallMs, gpuMs: n.gpuMs },
      // 1.7.0 (B-11703, B-11705): the node's thinking level and tokens, and the plan it ran under.
      think: n.think,
      thinkingTokens: n.thinkingTokens,
      plan: n.plan,
      subtree,
      createdAt: n.createdAt,
      finishedAt: n.finishedAt,
      durationMs: n.finishedAt == null ? null : n.finishedAt - n.createdAt,
      links: { run: runLink(n), audit: runLink(n) ? `/api/admin/audit?target=${n.ref}` : null },
      ...(entries ? { audit: entries } : {}),
      guardrails: decisions.get(n.ref) ?? [],
      replay: replayOf(n),
      held: held.filter((h) => h.node === n.id).map((h) => ({ at: h.at, tool: h.tool, sideEffect: h.sideEffect, since: h.since, approvers: h.approvers, canDecide: h.canDecide })),
      children
    };
  };
  const rootRow = c.nodes.find((n) => n.id === c.rootNode);
  const root = rootRow ? await build(rootRow) : null;
  const principal = (await s.db('users').where({ id: c.principal }).first('display_name', 'username')) as { display_name: string | null; username: string } | undefined;
  const totals = c.nodes.reduce((a, n) => ({ tokens: a.tokens + n.tokens, steps: a.steps + n.steps, wallMs: a.wallMs + n.wallMs, gpuMs: a.gpuMs + n.gpuMs }), { tokens: 0, steps: 0, wallMs: 0, gpuMs: 0 });
  return {
    id: c.id,
    state: c.state,
    stopReason: c.stopReason,
    label: c.label,
    principal: { id: c.principal, name: principal ? principal.display_name || principal.username : null },
    budgets: c.budgets,
    used: c.used,
    totals,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    nodes: c.nodes.length,
    maxDepth: c.nodes.reduce((m, n) => Math.max(m, n.depth), 0),
    limits: { maxDepth: s.chains.limits.maxDepth, kindCaps: s.chains.limits.kindCaps },
    links: { audit: `/api/admin/audit?target=${c.id}` },
    held,
    root
  };
}

/** Decides a held call from the chain (B-4106): where it waits, with the rules of that place. */
export async function decideHeld(s: Services, p: Principal, chainId: string, nodeId: string, b: { decision: 'approve' | 'reject'; note: string | null; step?: number | undefined; approval?: string | undefined }, ip: string | null) {
  const c = await chainFor(s, p, chainId);
  const node = c.nodes.find((n) => n.id === nodeId);
  if (!node) throw notFound('Chain node');
  const atNode = (await heldCalls(s, p, c.id, c.nodes)).filter((h) => h.node === nodeId);
  // Someone who can neither see the chain nor decide what it holds learns nothing about it.
  if (!mayView(p, c) && !atNode.some((h) => h.canDecide)) throw notFound('Chain');
  const held = atNode.filter((h) => (b.step == null || (h.at.kind === 'agent-run' && h.at.step === b.step)) && (b.approval == null || (h.at.kind === 'workflow-run' && h.at.approval === b.approval)));
  if (!held.length) throw conflict('Nothing is held at that node of the chain.');
  if (held.length > 1) throw conflict(`${held.length} calls are held at that node; name the one to decide with step or approval.`);
  const h = held[0]!;
  if (h.at.kind === 'agent-run') {
    const out = await s.agents.decide(p, h.at.run, h.at.step, b.decision, b.note);
    return { held: h, ...out };
  }
  const out = await s.workflows.decide(p, h.at.approval, { decision: b.decision, reason: b.note }, ip);
  return { held: h, decision: out.state, workflow: out };
}

/** Replays a node where its kind can replay: an agent run from a step, a workflow run from a step. */
export async function replayNode(s: Services, p: Principal, chainId: string, nodeId: string, b: { fromStep?: number | undefined; fromNode?: string | undefined }) {
  const c = await chainFor(s, p, chainId);
  if (!mayView(p, c)) throw notFound('Chain');
  const node = c.nodes.find((n) => n.id === nodeId);
  if (!node) throw notFound('Chain node');
  if (node.kind === 'agent-run') {
    if (b.fromStep == null) throw conflict('An agent run replays from a step: send fromStep.');
    const r = await s.agents.replay(p, node.ref, b.fromStep);
    return { kind: 'agent-run' as const, run: r.id, chain: r.chain?.id ?? null, label: r.label };
  }
  if (node.kind === 'workflow-run') {
    if (!b.fromNode) throw conflict('A workflow run replays from one of its steps: send fromNode.');
    const r = await s.workflows.replay(p, node.ref, b.fromNode);
    return { kind: 'workflow-run' as const, run: r.id, chain: r.chain_id ?? null, label: r.label, workflowId: r.workflow_id };
  }
  throw conflict(`A ${node.kind} node cannot be replayed on its own; replay the run it belongs to.`);
}
