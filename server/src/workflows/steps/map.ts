import { guardedByApproval, graphSchema, LIMITS, render, sampleOf, type TemplateScope } from '../graph.js';
import type { ResolvedTool } from '../../registry/dispatch.js';
import { childInput } from './sub.js';
import type { WAIT } from './host.js';
import { compare, pool, StepFailed, type StepCall, type StepHost, type StepResult } from './host.js';
import { STEP_KINDS, type ItemAction, type LoopConfig, type MapConfig } from './kinds.js';

/*
 * Map and loop (B-3905). A map runs one action (a model prompt through a profile, a registry tool, or a published
 * workflow as a child run) for every item of a list, at most `maxParallel` at once; a loop runs it again and again
 * while its condition holds, at most `max` times. Templates read `{{item}}` and `{{index}}` (map) or `{{iteration}}`,
 * `{{last}}` and `{{results}}` (loop) beside the usual `input` and `steps`.
 *
 * Both count toward the run limits: a run's maps fan out over at most `LIMITS.maxItems` items, every loop iteration
 * counts toward the 40-step limit at publish, items and iterations are steps (and their tokens tokens) of the chain,
 * whose root budgets are checked before each one starts. Each item's result is a checkpoint (`workflow_items`,
 * sealed), so a map resumes after a restart or a child's approval without running finished items again. Items never
 * pause for approvals one by one: a write tool needs an Approval step before the map (checked at publish), and a
 * child workflow that waits pauses the whole step until it is done.
 */

type ItemOutcome = { state: 'passed'; output: unknown; tokens: number } | { state: 'waiting'; childRun: string } | { state: 'failed'; error: string; childRun?: string | null };

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Resolves the action's tool once for the whole step. */
async function itemTool(c: StepCall, host: StepHost, a: ItemAction): Promise<ResolvedTool | null> {
  if (!a.tool) return null;
  const { tools, hidden } = await host.tools.resolve(c.p, [a.tool], c.label);
  const t = tools[0];
  if (!t) throw new StepFailed(`${a.tool} cannot be called: ${hidden[0]?.reason ?? 'not published to this workspace'}.`);
  if (t.entry.impl === 'workflow') throw new StepFailed(`${a.tool} is a workflow published as a tool; run the workflow itself instead.`);
  return t;
}

async function runItem(c: StepCall, host: StepHost, a: ItemAction, tool: ResolvedTool | null, scope: TemplateScope, key: string, local: Record<string, unknown>): Promise<ItemOutcome> {
  try {
    if (a.profile) {
      const r = await host.prompt(c, { profile: a.profile, prompt: a.prompt ?? '', format: a.format ?? 'text', scope });
      return { state: 'passed', output: r.output, tokens: r.tokens };
    }
    if (tool) {
      const args = a.args ? Object.fromEntries(Object.entries(a.args).map(([k, t]) => [k, render(t, scope)])) : isObject(local.item) ? local.item : { item: local.item };
      const guarded = guardedByApproval(graphSchema.parse(JSON.parse(c.run.graph)), c.n.id);
      const o = await host.tools.call({ principal: c.p, label: c.label, source: { kind: 'workflow-step', id: c.step.id }, signal: c.signal, approved: guarded, chain: host.chainOf(c.run) }, tool, args);
      if (o.needsApproval) return { state: 'failed', error: `${tool.entry.name} needs an approval; put an Approval step before the ${c.n.kind}.` };
      if (!o.ok) return { state: 'failed', error: o.error ?? `${tool.entry.name} failed.` };
      return { state: 'passed', output: o.result ?? null, tokens: 0 };
    }
    const r = await host.child(c, { workflow: a.workflow!, ...(a.version ? { version: a.version } : {}), input: childInput(a.input, scope, local), label: c.label, key, timeoutMs: c.n.timeoutMs ?? LIMITS.defaultStepTimeoutMs });
    if (r.state === 'waiting') return { state: 'waiting', childRun: r.run };
    if (r.state === 'failed') return { state: 'failed', error: r.error, childRun: r.run };
    return { state: 'passed', output: r.output, tokens: 0 };
  } catch (err) {
    if (c.signal.aborted) throw err;
    return { state: 'failed', error: (err as Error).message.slice(0, 1000) };
  }
}

function mockOf(c: StepCall): unknown {
  return sampleOf(c.n.output ?? { type: 'object' });
}

export async function runMap(c: StepCall, host: StepHost): Promise<StepResult | typeof WAIT> {
  const cfg = STEP_KINDS.map.config.parse(c.n.config) as MapConfig;
  if (c.run.mode === 'dry') return { output: c.n.output ? mockOf(c) : { [cfg.as]: [null], count: 1 }, detail: { mocked: true } };
  const list = render(cfg.over, c.scope);
  if (!Array.isArray(list)) throw new StepFailed(`${cfg.over} renders to ${list === undefined ? 'nothing' : typeof list}, not a list.`);
  if (list.length > cfg.maxItems) throw new StepFailed(`${list.length} items; this map takes at most ${cfg.maxItems}.`);
  const others = await host.items.countOthers(c);
  if (others + list.length > LIMITS.maxItems) throw new StepFailed(`${list.length} items here and ${others} in the run's other maps; a run fans out over at most ${LIMITS.maxItems}.`);
  const tool = await itemTool(c, host, cfg);
  const rows = new Map((await host.items.list(c)).map((r) => [r.idx, r]));
  const results: unknown[] = list.map((_, i) => (rows.get(i)?.state === 'passed' ? rows.get(i)!.output : undefined));
  const todo = list.map((_, i) => i).filter((i) => rows.get(i)?.state !== 'passed');
  const reused = list.length - todo.length;
  const chain = host.chainOf(c.run);
  let stop: string | null = null;
  let waiting = 0;
  let passedNow = 0;
  let tokens = 0;
  const peak = await pool(
    todo,
    cfg.maxParallel,
    async (i) => {
      if (chain && host.chains) {
        const over = await host.chains.check(chain);
        if (over) {
          stop ??= over;
          return;
        }
      }
      const local = { item: list[i], index: i };
      const r = await runItem(c, host, cfg, tool, { ...c.scope, ...local } as TemplateScope, `${c.n.id}#${i}`, local);
      if (r.state === 'passed') {
        await host.items.save(c, i, { state: 'passed', output: r.output, tokens: r.tokens });
        results[i] = r.output;
        passedNow++;
        tokens += r.tokens;
        if (chain && host.chains) {
          const { exceeded } = await host.chains.charge(chain, { steps: 1, tokens: r.tokens });
          if (exceeded) stop ??= exceeded;
        }
      } else if (r.state === 'waiting') {
        await host.items.save(c, i, { state: 'waiting', childRun: r.childRun });
        waiting++;
      } else {
        await host.items.save(c, i, { state: 'failed', error: r.error, childRun: r.childRun ?? null });
        stop ??= `item ${i + 1} of ${list.length}: ${r.error}`;
      }
    },
    () => stop != null || c.signal.aborted
  );
  if (c.signal.aborted) throw c.signal.reason as Error;
  const detail = { items: list.length, maxParallel: cfg.maxParallel, peak, reused, ran: passedNow };
  if (stop) throw new StepFailed(String(stop));
  if (waiting) return host.wait(c, { ...detail, waiting });
  return { output: { [cfg.as]: results, count: list.length }, tokens, charged: { steps: passedNow, tokens }, detail };
}

export async function runLoop(c: StepCall, host: StepHost): Promise<StepResult | typeof WAIT> {
  const cfg = STEP_KINDS.loop.config.parse(c.n.config) as LoopConfig;
  if (c.run.mode === 'dry') return { output: c.n.output ? mockOf(c) : { iterations: 1, last: null, results: [null], stopped: 'max' }, detail: { mocked: true } };
  const tool = await itemTool(c, host, cfg);
  const rows = new Map((await host.items.list(c)).map((r) => [r.idx, r]));
  const chain = host.chainOf(c.run);
  const results: unknown[] = [];
  let last: unknown = null;
  let stopped: 'condition' | 'max' = 'max';
  let passedNow = 0;
  let tokens = 0;
  for (let i = 0; i < cfg.max; i++) {
    if (c.signal.aborted) throw c.signal.reason as Error;
    const row = rows.get(i);
    if (row?.state === 'passed') {
      results.push(row.output);
      last = row.output;
      continue;
    }
    const local = { iteration: i, last, results: [...results] };
    const scope = { ...c.scope, ...local } as TemplateScope;
    // An iteration that started before (a child that waited) passed the condition then; it is not asked again.
    if (!row && cfg.while && !compare(cfg.while.op, render(cfg.while.left, scope), cfg.while.right)) {
      stopped = 'condition';
      break;
    }
    if (chain && host.chains) {
      const over = await host.chains.check(chain);
      if (over) throw new StepFailed(over);
    }
    const r = await runItem(c, host, cfg, tool, scope, `${c.n.id}#${i}`, local);
    if (r.state === 'waiting') {
      await host.items.save(c, i, { state: 'waiting', childRun: r.childRun });
      return host.wait(c, { iteration: i + 1, max: cfg.max });
    }
    if (r.state === 'failed') {
      await host.items.save(c, i, { state: 'failed', error: r.error, childRun: r.childRun ?? null });
      throw new StepFailed(`Iteration ${i + 1}: ${r.error}`);
    }
    await host.items.save(c, i, { state: 'passed', output: r.output, tokens: r.tokens });
    results.push(r.output);
    last = r.output;
    passedNow++;
    tokens += r.tokens;
    if (chain && host.chains) {
      const { exceeded } = await host.chains.charge(chain, { steps: 1, tokens: r.tokens });
      if (exceeded && i + 1 < cfg.max) throw new StepFailed(exceeded);
    }
  }
  return { output: { iterations: results.length, last, results, stopped }, tokens, charged: { steps: passedNow, tokens }, detail: { iterations: results.length, max: cfg.max, stopped } };
}
