import { hostname } from 'node:os';
import type { Knex } from 'knex';
import type { Config } from '../config/index.js';

/*
 * 1.7.0 (B-9001, decision D17): Redis is required for any install with more than one process, and the server refuses
 * to start without it. The bus carries what every process must hear at once (session revocations, role and guardrail
 * reloads, drains, job cancels, PDS and label announcements); without Redis it reaches only the process that
 * published, so a split web and worker install would silently never deliver what the worker makes.
 *
 * A process is one of several when its configuration says so (WORKERS_ENABLED=false: another process runs the jobs;
 * SERVER_REPLICAS above 1), or when the database holds another instance's live heartbeat (B-4202). The check is made
 * by the server process as it starts (`index.ts`), not by `createServices`: the CLI, setup scripts and tests use the
 * services against a database a server may be running on, and they neither heartbeat nor serve.
 *
 * A heartbeat is live while it is newer than `staleMs` (three beats and a margin, as the Overview decides "not
 * answering"). A clean shutdown removes its row, so a restart finds none. A row left by a process that was killed
 * names its host and pid: when the host is this one and the pid is gone, the row is removed and not counted, so a
 * single-process install restarts at once after a crash. A row from another host cannot be checked and counts until
 * it is stale.
 */

export interface SelfInstance {
  id: string;
  node?: string;
  pid?: number;
}

/** Whether a process of this host is alive (a signal 0: ESRCH means gone; EPERM means it is someone else's). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Why this install has more than one process, one sentence each; empty when nothing says so. */
export async function multiProcessReasons(
  cfg: Pick<Config, 'WORKERS_ENABLED' | 'SERVER_REPLICAS'>,
  db: Knex,
  self: SelfInstance,
  staleMs: number,
  alive: (pid: number) => boolean = pidAlive
): Promise<string[]> {
  const reasons: string[] = [];
  if (!cfg.WORKERS_ENABLED) reasons.push('WORKERS_ENABLED=false makes this an API process whose jobs another process runs');
  if (cfg.SERVER_REPLICAS > 1) reasons.push(`SERVER_REPLICAS=${cfg.SERVER_REPLICAS} says the install runs more than one server process`);
  const node = self.node ?? hostname();
  const pid = self.pid ?? process.pid;
  const rows = (await db('platform_instances').where('heartbeat_at', '>', Date.now() - staleMs).whereNot({ id: self.id }).select('id', 'node', 'pid', 'heartbeat_at')) as { id: string; node: string; pid: number | string; heartbeat_at: number | string }[];
  const live: string[] = [];
  for (const r of rows) {
    if (String(r.node) === node && Number(r.pid) !== pid && !alive(Number(r.pid))) {
      // This host's own process, gone without a clean shutdown: its row goes with it.
      await db('platform_instances').where({ id: r.id }).delete().catch(() => undefined);
      continue;
    }
    live.push(`${r.id} (heartbeat ${Math.max(0, Math.round((Date.now() - Number(r.heartbeat_at)) / 1000))} s ago)`);
  }
  if (live.length) reasons.push(`another server process is running on this database: ${live.slice(0, 5).join(', ')}${live.length > 5 ? ` and ${live.length - 5} more` : ''}`);
  return reasons;
}

/** The message a server process stops with; null when it may start. */
export async function redisRequirement(
  cfg: Pick<Config, 'WORKERS_ENABLED' | 'SERVER_REPLICAS' | 'REDIS_URL'>,
  db: Knex,
  self: SelfInstance,
  staleMs: number,
  alive?: (pid: number) => boolean
): Promise<string | null> {
  if (cfg.REDIS_URL) return null;
  const reasons = await multiProcessReasons(cfg, db, self, staleMs, alive);
  if (!reasons.length) return null;
  return `REDIS_URL is required because ${reasons.join('; and ')}. Without Redis, what one process publishes (session revocations, role and guardrail reloads, job cancels, PDS and label events) never reaches the others. Set REDIS_URL (or REDIS_URL_FILE) on every process, or run a single process.`;
}
