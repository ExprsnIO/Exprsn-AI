import { renderText } from '../graph.js';
import { HttpProblem } from '../../http/problem.js';
import { ChainLimit } from '../../chain/context.js';
import type { WAIT } from './host.js';
import { detailOf, StepBlocked, StepFailed, type StepCall, type StepHost, type StepResult } from './host.js';
import { STEP_KINDS, type AgentStepConfig } from './kinds.js';

/*
 * The agent step (B-3902): a published registry agent runs as the run's owner, under the step's label, within its
 * budgets (raised or lowered by the step up to the registry maximum) and as a child in the run's chain. It is awaited
 * like a workflow tool is awaited by an agent run (B-1006), the other way round: the step waits without holding a
 * worker, and the agent run's end (succeeded, failed, cancelled or stopped at a budget) resumes the workflow run.
 */

const DONE = ['succeeded', 'failed', 'cancelled', 'budget'];

export async function runAgent(c: StepCall, host: StepHost): Promise<StepResult | typeof WAIT> {
  const cfg = STEP_KINDS.agent.config.parse(c.n.config) as AgentStepConfig;
  if (c.run.mode === 'dry') return { output: { run: null, text: `Mocked answer from ${cfg.agent}.` }, detail: { mocked: true, agent: cfg.agent } };
  if (!host.agents) throw new StepFailed('Agent steps are not available on this server.');
  const detail = detailOf(c);
  let runId = typeof detail.agentRun === 'string' ? detail.agentRun : null;
  if (!runId) {
    const task = cfg.input !== undefined ? renderText(cfg.input, c.scope) : JSON.stringify(c.merged);
    if (!task.trim()) throw new StepFailed(`${c.n.title}: the task for ${cfg.agent} is empty.`);
    try {
      const started = await host.agents.startForStep(c.p, { agent: cfg.agent, input: task, label: c.label, ...(cfg.budgets ? { budgets: cfg.budgets } : {}) }, { runId: c.run.id, node: c.n.id, chain: host.chainOf(c.run) });
      runId = started.id;
    } catch (err) {
      if (err instanceof ChainLimit) throw new StepFailed(err.message);
      if (err instanceof HttpProblem && err.status === 403 && (err.extensions as { step?: string } | undefined)?.step === 'zone') throw new StepBlocked(`Blocked by label ceiling: ${err.detail ?? err.title}`);
      if (err instanceof HttpProblem) throw new StepFailed(err.detail ?? err.title);
      throw err;
    }
    await host.note(c, { agentRun: runId, agent: cfg.agent });
  }
  const st = await host.agents.stateForStep(c.run.tenant_id, runId);
  if (!st) throw new StepFailed(`The agent run behind ${c.n.title} no longer exists.`);
  if (!DONE.includes(st.state)) return host.wait(c, { agentRun: runId, agent: cfg.agent, agentState: st.state });
  if (st.state !== 'succeeded') throw new StepFailed(`${cfg.agent} run ${runId} ${st.state === 'budget' ? 'stopped at its budget' : st.state}${st.error ? `: ${st.error}` : ''}`);
  return { output: { run: runId, text: st.output ?? '' }, label: st.label, detail: { agentRun: runId, agent: cfg.agent, agentTokens: st.tokens } };
}
