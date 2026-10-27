import { z } from 'zod';
import { entryFor, knownPattern } from '../events/catalogue.js';
import { checkTimeZone, nextRun, parseSchedule } from './schedules.js';
import type { Issue } from './graph.js';

/*
 * Sprint 32b (B-3903): the trigger step's configuration, and its checks at publish. Besides `manual` and `api`, and
 * the `record` and `schedule` sources an app's triggers start (1.4.0, B-2206), a workflow starts by itself on:
 *
 * - `event`: a catalogue event (`file.uploaded`) or group (`file.*`); the fan-out rules are the plugins' (workspace,
 *   label, rate, loop chain), see `triggers.ts`;
 * - `schedule` with `cron`: a five-field UTC cron (the training calendar's parser), claimed once across instances.
 *   A `schedule` trigger without `cron` is still started by an app's schedule trigger. 1.8.0 (B-138): `timezone`, an
 *   IANA zone the cron's wall-clock times are read in (default UTC, so older schedules are unchanged), with presets,
 *   names, `L`, `W` and `#` (`schedules.ts`).
 * - `webhook` (1.8.0, B-130): a signed POST to `/hooks/workflows/<tenant>/<workflowId>` (`hooks.ts`). It takes no
 *   configuration here: the hook's secret, its owner and whether it is on live beside the workflow, never in the graph,
 *   so a version or a bundle carries none of them.
 */

export const TRIGGER_SOURCES = ['manual', 'api', 'record', 'schedule', 'event', 'webhook'] as const;
export type TriggerSource = (typeof TRIGGER_SOURCES)[number];

export const triggerConfigSchema = z
  .object({
    source: z.enum(TRIGGER_SOURCES).default('manual'),
    /** `event` triggers: a catalogue event type, or a group pattern ending in `.*`. */
    event: z.string().trim().min(1).max(120).regex(/^[a-z][a-z0-9_.-]*(\.\*)?$/, 'An event type such as file.uploaded, or a group such as file.*').optional(),
    /** `schedule` triggers that start the workflow by themselves: five fields, UTC. */
    cron: z.string().trim().min(9).max(120).optional(),
    /** 1.8.0 (B-138): the IANA zone of a schedule's cron (`Europe/Berlin`); absent is UTC. */
    timezone: z.string().trim().min(1).max(64).optional()
  })
  .strict();
export type TriggerConfig = z.infer<typeof triggerConfigSchema>;

/** What a published trigger asks the trigger service to run, or null when something else starts the workflow. */
export function selfTrigger(cfg: TriggerConfig): { kind: 'event'; event: string } | { kind: 'schedule'; cron: string; timezone: string | null } | null {
  if (cfg.source === 'event' && cfg.event) return { kind: 'event', event: cfg.event };
  if (cfg.source === 'schedule' && cfg.cron) return { kind: 'schedule', cron: cfg.cron, timezone: cfg.timezone && cfg.timezone !== 'UTC' ? cfg.timezone : null };
  return null;
}

/** Publish checks of a trigger step whose configuration parsed. */
export function triggerIssues(n: { id: string; title: string }, cfg: TriggerConfig): { errors: Issue[]; warnings: Issue[] } {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const err = (message: string) => errors.push({ code: 'config', nodeId: n.id, message: `${n.title}: ${message}` });
  if (cfg.event && cfg.source !== 'event') err('only an event trigger names an event.');
  if (cfg.cron && cfg.source !== 'schedule') err('only a schedule trigger has a cron expression.');
  if (cfg.timezone && cfg.source !== 'schedule') err('only a schedule trigger has a time zone.');
  if (cfg.source === 'event') {
    if (!cfg.event) err('name the catalogue event that starts the workflow, such as file.uploaded.');
    else if (cfg.event === '*' || !knownPattern(cfg.event)) err(`${cfg.event} is not an event or group in the catalogue.`);
    else if (!cfg.event.endsWith('.*') && entryFor(cfg.event).status === 'reserved') warnings.push({ code: 'config', nodeId: n.id, message: `${n.title}: ${cfg.event} is reserved in the catalogue and not emitted yet; the workflow does not start until its domain ships.` });
  }
  let zoneOk = true;
  if (cfg.source === 'schedule' && cfg.timezone) {
    try {
      checkTimeZone(cfg.timezone);
    } catch (e) {
      zoneOk = false;
      err((e as Error).message);
    }
  }
  if (cfg.source === 'schedule' && cfg.cron) {
    try {
      parseSchedule(cfg.cron);
      if (zoneOk && nextRun(cfg.cron, Date.now(), cfg.timezone) == null) err('this cron expression never matches within a year.');
    } catch (e) {
      err(`the schedule is not a valid cron expression: ${(e as Error).message}`);
    }
  }
  return { errors, warnings };
}
