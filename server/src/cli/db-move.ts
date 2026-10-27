import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import type { MoveRecord, TargetSpec } from '../cloud/db-move.js';
import type { Services } from '../services.js';

/*
 * 1.9.99-final, Sprint 59 (B-10302): `exprsn-ai db:move`, moving this install's database onto a managed PostgreSQL
 * (`cloud/db-move.ts`). The operator on the host runs it directly (the console's route is under dual control).
 */

export const DB_MOVE_USAGE = `  db:move --to <target>        1.9.99-final: move this install's database onto a managed PostgreSQL: preflight (TLS
      [--ca-file <pem>]        with the provider's CA bundle, connection budget, empty target), schema, read-only
      [--switch-file <file>]   window, backup:create, restore, verify (audit:verify on the target), migrate --check,
      [--instances <n>]        switch DATABASE_URL in its file (default DATABASE_URL_FILE; the old one stays as
      [--window-minutes <n>]   <file>.previous and the old database read-only for --keep-old-days, default 7).
      [--keep-old-days <n>]    <target> is a file holding the target URL, or a deployment (id or name) whose
      [--dry-run] [--yes]      database is wired. --dry-run checks and estimates only. Restart every instance after.
  db:move --status|--resume|--rollback [--discard-new-writes]|--finish [--id <move>]
                               The open move's state; resume after a crash; roll back (before the switch, or after it
                               within the keep window); end the keep window
`;

async function confirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const a = await new Promise<string>((resolve) => rl.question(prompt, resolve));
  rl.close();
  return /^y(es)?$/i.test(a.trim());
}

function print(m: MoveRecord, write: (t: string) => void): void {
  write(`Move ${m.id}: ${m.state}${m.dryRun ? ' (dry run)' : ''}\n`);
  if (m.view) write(`  target  ${m.view.client === 'pg' ? `postgres ${m.view.host}:${m.view.port}/${m.view.database ?? ''}` : `sqlite ${m.view.database}`}${m.view.provider ? ` (${m.view.provider}${m.view.size ? ` ${m.view.size}` : ''})` : ''}\n`);
  for (const c of m.checks) write(`  ${c.ok ? 'ok  ' : 'FAIL'}  ${c.id}: ${c.detail}\n`);
  if (!m.dryRun) for (const [k, v] of Object.entries(m.steps)) write(`  step ${k.padEnd(14)} ${v.state}${v.finishedAt && v.startedAt ? ` (${Math.max(0, v.finishedAt - v.startedAt)} ms)` : ''}\n`);
  if (m.switchedAt) write(`  switched ${new Date(m.switchedAt).toISOString()}; window ${Math.ceil((m.switchedAt - (m.window.openedAt ?? m.switchedAt)) / 1000)} s; old database kept read-only (${m.oldReadOnly}) until ${m.keepOldUntil ? new Date(m.keepOldUntil).toISOString() : '?'}\n`);
  if (m.error) write(`  error: ${m.error}\n`);
}

async function targetOf(s: Services, to: string): Promise<TargetSpec> {
  if (existsSync(to)) return { kind: 'url_file', path: to };
  if (/^[0-9A-HJKMNP-TV-Z]{26}$/.test(to)) return { kind: 'deployment', deploymentId: to };
  const row = (await s.db('cloud_deployments').where({ name: to.toLowerCase() }).first('id').catch(() => null)) as { id: string } | null | undefined;
  if (row) return { kind: 'deployment', deploymentId: row.id };
  throw new Error(`--to ${to} is neither a file holding the target URL nor a deployment.`);
}

export async function dbMoveCommand(s: Services, argv: string[], write: (t: string) => void): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      to: { type: 'string' },
      'ca-file': { type: 'string' },
      'switch-file': { type: 'string' },
      instances: { type: 'string' },
      'window-minutes': { type: 'string' },
      'keep-old-days': { type: 'string' },
      'dry-run': { type: 'boolean' },
      'insecure-no-tls': { type: 'boolean' },
      yes: { type: 'boolean' },
      status: { type: 'boolean' },
      resume: { type: 'boolean' },
      rollback: { type: 'boolean' },
      'discard-new-writes': { type: 'boolean' },
      finish: { type: 'boolean' },
      id: { type: 'string' }
    }
  });
  const moves = s.cloud.dbMoves;
  moves.hooks.progress = (m) => void process.stderr.write(`${m}\n`);
  const actor = { service: 'cli' as const };
  const pick = async () => (values.id ? moves.get(values.id) : await moves.active());
  if (values.status || values.resume || values.rollback || values.finish) {
    const m = await pick();
    if (!m) {
      write('No open database move.\n');
      return values.status ? 0 : 2;
    }
    const out = values.resume ? await moves.run(m.id, actor) : values.rollback ? await moves.rollback(m.id, actor, { discardNewWrites: !!values['discard-new-writes'] }) : values.finish ? await moves.finish(m.id, actor) : m;
    print(out, write);
    if (values.resume && out.state === 'switched') write('DATABASE_URL is switched. Restart every instance now.\n');
    return 0;
  }
  if (!values.to) throw new Error('db:move needs --to <url file or deployment> (or --status, --resume, --rollback, --finish).');
  const num = (v: string | undefined) => (v == null ? undefined : Number.parseInt(v, 10));
  const plan = await moves.plan(
    {
      target: await targetOf(s, values.to),
      caFile: values['ca-file'] ?? null,
      ...(values['switch-file'] ? { switchFile: values['switch-file'] } : {}),
      ...(num(values.instances) ? { instances: num(values.instances)! } : {}),
      ...(num(values['window-minutes']) ? { windowMinutes: num(values['window-minutes'])! } : {}),
      ...(num(values['keep-old-days']) ? { keepOldDays: num(values['keep-old-days'])! } : {}),
      dryRun: !!values['dry-run'],
      requireTls: !values['insecure-no-tls']
    },
    actor
  );
  print(plan, write);
  if (plan.checks.some((c) => !c.ok)) {
    write('The preflight refused the move; nothing was changed.\n');
    return 2;
  }
  if (plan.dryRun) {
    write('Dry run: nothing was changed.\n');
    return 0;
  }
  if (!values.yes && !(await confirm(`This opens a read-only window of about ${Math.ceil((plan.estimate?.windowMs ?? 0) / 1000)} s and switches DATABASE_URL in ${plan.switchFile}. Continue? [y/N] `))) {
    write('Not started.\n');
    return 1;
  }
  const done = await moves.run(plan.id, actor);
  print(done, write);
  write('DATABASE_URL is switched. Restart every instance now; db:move --rollback goes back while the old database is kept.\n');
  return 0;
}
