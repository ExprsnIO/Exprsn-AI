import type { Config } from '../config/index.js';

/** The GPU training worker the orchestrator drives (a Python trainer over HTTP; a fake in tests). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface TrainerBackend {}

export function createTrainer(_cfg: Config): TrainerBackend {
  return {};
}
