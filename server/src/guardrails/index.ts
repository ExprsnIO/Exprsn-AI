import type { Logger } from 'pino';
import type { Db } from '../db/knex.js';
import type { Gateway } from '../gateway/gateway.js';
import type { Bus } from '../platform/bus.js';
import type { DataKeys } from '../platform/datakeys.js';
import type { JobQueue } from '../platform/jobs.js';
import type { Notifications } from '../platform/notifications.js';
import { ClassifierService } from './classifiers.js';
import { GuardrailEngine } from './engine.js';
import { FlagService } from './flags.js';
import { RuleTestService } from './rule-tests.js';
import { RuleSetService } from './sets.js';
import { TermListService } from './terms.js';
import { treeTermRefs } from './conditions.js';

/** Sprint 5: the rule-set engine behind the checkpoint seam, the flag queue and the classifier registry. */
export interface GuardrailModule {
  engine: GuardrailEngine;
  sets: RuleSetService;
  flags: FlagService;
  classifiers: ClassifierService;
  /** 1.9.0 (B-156): named term lists. */
  terms: TermListService;
  /** 1.9.0 (B-155): rule-set tests. */
  tests: RuleTestService;
}

export function createGuardrails(d: { db: Db; keys: DataKeys; gateway: Gateway; bus: Bus; notifications: Notifications; jobs: JobQueue; log: Logger }): GuardrailModule {
  const sets = new RuleSetService(d.db, d.bus);
  const flags = new FlagService(d.db, d.keys, d.bus, d.notifications);
  const classifiers = new ClassifierService(d.db, d.keys, d.gateway, d.jobs);
  const engine = new GuardrailEngine(d.db, d.keys, d.gateway, sets, classifiers, flags, d.log, d.jobs);
  const terms = new TermListService(d.db, d.bus);
  engine.terms = terms;
  // A rule saved into a draft may refer only to term lists of the set's tenant.
  sets.refCheck = (set, rules) => terms.checkRefs(set.tenant_id, rules.flatMap((r) => (r.mechanism.kind === 'term-list' ? [{ ruleId: r.id, ref: { list: r.mechanism.list, version: r.mechanism.version } }, ...(r.mechanism.except ? [{ ruleId: r.id, ref: r.mechanism.except }] : [])] : r.mechanism.kind === 'conditions' ? treeTermRefs(r.mechanism.when).map((ref) => ({ ruleId: r.id, ref })) : [])));
  const tests = new RuleTestService(d.db, d.keys, engine, sets, d.jobs);
  return { engine, sets, flags, classifiers, terms, tests };
}
