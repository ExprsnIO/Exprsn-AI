import type { StepKindName } from './kinds.js';
import type { StepRunner } from './host.js';
import { runAgent } from './agent.js';
import { runLoop, runMap } from './map.js';
import { runSub } from './sub.js';

/**
 * Run-time half of the Workflows 2 kinds of Sprint 32a (the publish-time half is `kinds.ts`). The workflow service's
 * `runNode` dispatches every kind in `STEP_KINDS` here. Kinds whose steps wait on something outside the run (a child
 * workflow run, an agent run) are in `RESUMES`: when the run is resumed, their waiting step runs again and picks up
 * where it was (the runner reads its own checkpoint from the step's detail or `workflow_items`).
 */
export const STEP_RUNNERS: Record<StepKindName, StepRunner> = { sub: runSub, agent: runAgent, map: runMap, loop: runLoop };
export const RESUMES: ReadonlySet<string> = new Set<StepKindName>(['sub', 'agent', 'map', 'loop']);

export * from './host.js';
export * from './kinds.js';
