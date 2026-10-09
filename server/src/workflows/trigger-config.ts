import { z } from 'zod';
import { entryFor, knownPattern } from '../events/catalogue.js';
import { nextCron, parseCron } from '../training/calendar.js';
import type { Issue } from './graph.js';

/*
 * Sprint 32b (B-3903): the trigger step's configuration, and its checks at publish. Besides `manual` and `api`, and
 * the `record` and `schedule` sources an app's triggers start (1.4.0, B-2206), a workflow starts by itself on:
 *
 * - `event`: a catalogue event (`file.uploaded`) or group (`file.*`); the fan-out rules are the plugins' (workspace,
 *   label, rate, loop chain), see `triggers.ts`;
 * - `schedule` with `cron`: a five-field UTC cron (the training calendar's parser), claimed once across instances.
 *   A `schedule` trigger without `cron` is still started by an app's schedule trigger.
 *
 * Live review 2026-10-09: an `event` trigger on a job event (`job.succeeded`, `job.failed`, `job.cancelled`, `job.*`)
 * may name a `jobType`, one job type (`training.package`) or a group (`training.*`). The trigger service checks it
 * against the event's `data.type` before the rate limiter and the enqueue, so other jobs' events cost nothing.
 */

/** The job events a `jobType` narrows. */
export const JOB_EVENTS = ['job.succeeded', 'job.failed', 'job.cancelled', 'job.*'] as const;
export const isJobEvent = (event: string | null | undefined): boolean => !!event && (JOB_EVENTS as readonly string[]).includes(event);

/** Whether a job type matches a trigger's `jobType`: the same type, or under a `prefix.*` group. */
export function matchesJobType(pattern: string, type: unknown): boolean {
  if (typeof type !== 'string') return false;
  return pattern.endsWith('.*') ? type.startsWith(pattern.slice(0, -1)) : type === pattern;
}

export const TRIGGER_SOURCES = ['manual', 'api', 'record', 'schedule', 'event'] as const;
export type TriggerSource = (typeof TRIGGER_SOURCES)[number];

export const triggerConfigSchema = z
  .object({
    source: z.enum(TRIGGER_SOURCES).default('manual'),
    /** `event` triggers: a catalogue event type, or a group pattern ending in `.*`. */
    event: z.string().trim().min(1).max(120).regex(/^[a-z][a-z0-9_.-]*(\.\*)?$/, 'An event type such as file.uploaded, or a group such as file.*').optional(),
    /** `event` triggers on a job event: the job type (`training.package`) or group (`training.*`) that starts it. */
    jobType: z.string().trim().min(1).max(120).regex(/^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)*(\.\*)?$/, 'A job type such as training.package, or a group such as training.*').optional(),
    /** `schedule` triggers that start the workflow by themselves: five fields, UTC. */
    cron: z.string().trim().min(9).max(120).optional()
  })
  .strict();
export type TriggerConfig = z.infer<typeof triggerConfigSchema>;

/** What a published trigger asks the trigger service to run, or null when something else starts the workflow. */
export function selfTrigger(cfg: TriggerConfig): { kind: 'event'; event: string; jobType: string | null } | { kind: 'schedule'; cron: string } | null {
  if (cfg.source === 'event' && cfg.event) return { kind: 'event', event: cfg.event, jobType: isJobEvent(cfg.event) ? (cfg.jobType ?? null) : null };
  if (cfg.source === 'schedule' && cfg.cron) return { kind: 'schedule', cron: cfg.cron };
  return null;
}

/** Publish checks of a trigger step whose configuration parsed. */
export function triggerIssues(n: { id: string; title: string }, cfg: TriggerConfig): { errors: Issue[]; warnings: Issue[] } {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const err = (message: string) => errors.push({ code: 'config', nodeId: n.id, message: `${n.title}: ${message}` });
  if (cfg.event && cfg.source !== 'event') err('only an event trigger names an event.');
  if (cfg.cron && cfg.source !== 'schedule') err('only a schedule trigger has a cron expression.');
  if (cfg.jobType && (cfg.source !== 'event' || !isJobEvent(cfg.event))) err(`a job type narrows only a trigger on ${JOB_EVENTS.join(', ')}.`);
  if (cfg.source === 'event') {
    if (!cfg.event) err('name the catalogue event that starts the workflow, such as file.uploaded.');
    else if (cfg.event === '*' || !knownPattern(cfg.event)) err(`${cfg.event} is not an event or group in the catalogue.`);
    else if (!cfg.event.endsWith('.*') && entryFor(cfg.event).status === 'reserved') warnings.push({ code: 'config', nodeId: n.id, message: `${n.title}: ${cfg.event} is reserved in the catalogue and not emitted yet; the workflow does not start until its domain ships.` });
  }
  if (cfg.source === 'schedule' && cfg.cron) {
    try {
      parseCron(cfg.cron);
      if (nextCron(cfg.cron, Date.now()) == null) err('this cron expression never matches within a year.');
    } catch (e) {
      err(`the schedule is not a valid cron expression: ${(e as Error).message}`);
    }
  }
  return { errors, warnings };
}
