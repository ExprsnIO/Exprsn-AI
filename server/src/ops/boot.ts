import { PLATFORM_SCOPE } from '../platform/datakeys.js';
import type { Services } from '../services.js';

/*
 * 1.7.0 (B-9202, VLT-6): the order a server starts in, and the step it stops at.
 *
 * Sessions, API keys and every signed link are keyed from the vault's platform scope (B-9205), so the vault must be
 * open before the authentication middleware answers a request. The order is: configuration, database, KMS, data
 * keys, the vault's platform scope, sessions and API keys, then the authentication middleware. `index.ts` runs the
 * first two itself and calls `openVault` for the next four; a step that fails throws a `BootError` naming it, the
 * process exits, and nothing listens. A process that goes on regardless (a test, a script) leaves the platform keys
 * closed: every keyed read refuses with 503 and `authenticate` refuses every request (fail closed).
 */

export const BOOT_STEPS = ['configuration', 'database', 'kms', 'data-keys', 'vault-system-scope', 'sessions-and-api-keys', 'authentication'] as const;
export type BootStep = (typeof BOOT_STEPS)[number];

export class BootError extends Error {
  constructor(
    readonly step: BootStep,
    cause: unknown
  ) {
    super(`at step ${step} (${BOOT_STEPS.indexOf(step) + 1} of ${BOOT_STEPS.length}): ${(cause as Error)?.message || String(cause)}`);
    this.name = 'BootError';
  }
}

/** Runs one named step; whatever it throws is reported with the step's name. */
export async function bootStep<T>(step: BootStep, fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw err instanceof BootError ? err : new BootError(step, err);
  }
}

/** The steps between the database and the authentication middleware. Returns the steps passed, in order. */
export async function openVault(s: Services): Promise<BootStep[]> {
  const done: BootStep[] = [];
  // 1.8.0 (B-145): a persisted emergency seal holds the server sealed. It starts and serves what needs no key (health,
  // the console's static files, the unseal page); the steps below run when the escrow quorum unseals it.
  s.vaultSeal.reopen = async () => {
    await openVault(s);
  };
  if (await s.vaultSeal.restore()) {
    s.log.warn('vault: sealed (vault_seal_state); the key steps wait for the escrow quorum to unseal it');
    return done;
  }
  const run = async (step: BootStep, fn: () => Promise<void>) => {
    try {
      await bootStep(step, fn);
    } catch (err) {
      s.sysKeys.refuse(`the server stopped ${(err as Error).message}`);
      throw err;
    }
    done.push(step);
  };
  await run('kms', async () => {
    const h = await s.kms.health();
    if (!h.ok) throw new Error(`the KMS (${s.kms.kind}) is not reachable: ${h.detail}`);
  });
  await run('data-keys', async () => {
    // The platform data key seals the vault's platform scope: it must wrap and unwrap before anything is read.
    const probe = await s.keys.seal(PLATFORM_SCOPE, 'boot', 'boot-probe');
    if ((await s.keys.open(PLATFORM_SCOPE, probe, 'boot-probe')) !== 'boot') throw new Error('the platform data key does not open what it sealed');
  });
  await run('vault-system-scope', () => s.sysKeys.open());
  await run('sessions-and-api-keys', async () => {
    // Both read their key now, and both tables answer: the first request must not be the first to find out.
    s.sysKeys.key('session').all();
    s.sysKeys.key('api-key').all();
    await s.db('sessions').first('id');
    await s.db('api_keys').first('id');
    // 1.7.0 (B-9206): sessions and keys may be leases, whichever store new ones go to.
    await s.db('vault_leases').first('id');
    // A key revoked by a build that knows no leases stays revoked: its lease is ended before the first request.
    await s.apiKeys.reconcileLeases();
  });
  return done;
}
