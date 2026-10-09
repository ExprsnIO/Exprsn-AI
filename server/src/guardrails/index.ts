import type { Logger } from 'pino';
import type { Db } from '../db/knex.js';
import type { Gateway } from '../gateway/gateway.js';
import type { Bus } from '../platform/bus.js';
import type { DataKeys } from '../platform/datakeys.js';
import type { JobQueue } from '../platform/jobs.js';
import type { Notifications } from '../platform/notifications.js';
import { ClassifierService, type ClassifierWorker } from './classifiers.js';
import { GuardrailEngine } from './engine.js';
import { FlagService } from './flags.js';
import { RuleSetService } from './sets.js';

/** Sprint 5: the rule-set engine behind the checkpoint seam, the flag queue and the classifier registry. */
export interface GuardrailModule {
  engine: GuardrailEngine;
  sets: RuleSetService;
  flags: FlagService;
  classifiers: ClassifierService;
}

export function createGuardrails(d: { db: Db; keys: DataKeys; gateway: Gateway; bus: Bus; notifications: Notifications; jobs: JobQueue; log: Logger; classifierWorker?: ClassifierWorker }): GuardrailModule {
  const sets = new RuleSetService(d.db, d.bus);
  const flags = new FlagService(d.db, d.keys, d.bus, d.notifications);
  const classifiers = new ClassifierService(d.db, d.keys, d.gateway, d.jobs, d.classifierWorker);
  const engine = new GuardrailEngine(d.db, d.keys, d.gateway, sets, classifiers, flags, d.log, d.jobs);
  return { engine, sets, flags, classifiers };
}
