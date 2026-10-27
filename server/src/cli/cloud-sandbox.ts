import { parseArgs } from 'node:util';
import type { Principal } from '../authz/policy.js';
import type { CloudActor } from '../cloud/accounts.js';
import { CloudSandboxRun } from '../cloud/sandbox-run.js';
import { loadPrincipal } from '../http/middleware.js';
import type { Services } from '../services.js';

/*
 * 1.9.99-final, Sprint 62 (B-10804): `exprsn-ai cloud:sandbox-run`, the nightly sandbox cycle
 * (`cloud/sandbox-run.ts`), run by `.github/workflows/cloud-nightly.yml` against a control plane of its own. It refuses
 * every account not marked sandbox, without a budget, or at or past its budget; `--dry-run` changes nothing anywhere.
 * The cycle acts as `--as`, a person of the default tenant holding Cloud admin (and platform:manage for platform
 * accounts), loaded fresh with their current roles, so the audit trail names who the job ran as.
 */

export const CLOUD_SANDBOX_USAGE = `  cloud:sandbox-run            1.9.99-final: the nightly sandbox cycle on dedicated sandbox accounts (deploy, verify,
      --accounts <id,id> --as <username>   drift, revert, upgrade, destroy, sweep); exit 2 when a cycle fails or is refused
      [--dry-run] [--max-age-hours 24] [--json]
      --mark <id> | --unmark <id> --as <username>   mark an account as a sandbox (it needs a budget, no other deployments)
      --history <id>               the last runs of an account and how many in a row passed with nothing left
`;

async function actorFor(s: Services, who: string): Promise<CloudActor> {
  const tenant = await s.tenants.bySlug(s.cfg.DEFAULT_TENANT);
  if (!tenant) throw new Error('The default tenant is missing.');
  const u = (await s.db('users').where({ tenant_id: tenant.id }).andWhere((q) => void q.where({ username: who }).orWhere({ id: who }).orWhere({ email: who })).first('id', 'state')) as { id: string; state: string } | undefined;
  if (!u || u.state !== 'active') throw new Error(`--as ${who} is not an active person of the default tenant.`);
  const p = await loadPrincipal(s, tenant.id, u.id, {});
  if (!p) throw new Error(`--as ${who} could not be loaded.`);
  // The operator on the host runs the command (the same trust as backup:restore); the second factor is theirs.
  return { principal: { ...p, mfa: true } as Principal, ip: null };
}

export async function cloudSandboxCommand(s: Services, args: string[], write: (t: string) => void): Promise<number> {
  const { values } = parseArgs({ args, options: { accounts: { type: 'string' }, as: { type: 'string' }, 'dry-run': { type: 'boolean' }, 'max-age-hours': { type: 'string' }, json: { type: 'boolean' }, mark: { type: 'string' }, unmark: { type: 'string' }, history: { type: 'string' } } });
  const run = new CloudSandboxRun(() => s);
  if (values.history) {
    write(JSON.stringify(await run.history(values.history), null, 2) + '\n');
    return 0;
  }
  if (!values.as) {
    write(CLOUD_SANDBOX_USAGE);
    return 64;
  }
  const actor = await actorFor(s, values.as);
  if (values.mark || values.unmark) {
    const a = await run.mark((values.mark ?? values.unmark)!, !!values.mark, actor);
    write(`${a.name} is ${values.mark ? 'now' : 'no longer'} a sandbox account.\n`);
    return 0;
  }
  const ids = (values.accounts ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!ids.length) {
    write(CLOUD_SANDBOX_USAGE);
    return 64;
  }
  const hours = values['max-age-hours'] ? Number(values['max-age-hours']) : 24;
  if (!Number.isFinite(hours) || hours < 1) throw new Error('--max-age-hours is at least 1.');
  const report = await run.run({ accountIds: ids, actor, dryRun: !!values['dry-run'], maxAgeMs: hours * 3_600_000, ...(values.json ? {} : { log: (l: string) => write(`${l}\n`) }) });
  if (values.json) write(JSON.stringify(report, null, 2) + '\n');
  else write(`Run ${report.runId}: ${report.accounts.map((a) => `${a.name ?? a.accountId} ${a.status}${a.refusal ? ` (${a.refusal})` : ''}, ${a.leftovers} left`).join('; ')}\n`);
  return report.ok ? 0 : 2;
}
