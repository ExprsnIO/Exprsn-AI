import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { HttpProblem } from '../http/problem.js';
import type { Services } from '../services.js';

/*
 * 1.8.0, Sprint 48 (B-145): the emergency seal from the command line, against the configured database (and the
 * signer, when SIGNER_SOCKET is set; and Redis, when REDIS_URL is set, so running instances hear it at once; without
 * Redis they find it within a few seconds by polling the persisted flag).
 *
 *   vault:seal-status                                   sealed or not, the escrow, the last seal
 *   vault:unseal [--share <text>]... [--check <kcv>]    unseal with k shares (or one per line on stdin)
 *   vault:unseal --signer-only [--share <text>]...      unseal this host's signer after the vault was unsealed elsewhere
 *   vault:seal --break-glass --reason <text> [--share <text>]...   seal at once with k shares, no session
 *
 * Shares are read from the arguments or stdin, used in memory and never written anywhere; the audit chain records
 * which share numbers were given, never a share.
 */

export const VAULT_SEAL_COMMANDS = ['vault:seal-status', 'vault:unseal', 'vault:seal'] as const;

export const VAULT_SEAL_USAGE = `  vault:seal-status            1.8.0 (B-145): whether the vault is sealed, its escrow (k of n) and the last seal
  vault:unseal [--share <t>]... [--check <kcv>] [--signer-only]
                               Unseal the vault with k escrow shares (as --share, or one per line on stdin). Every
                               instance reopens its keys. --signer-only unseals this host's signer when the vault was
                               unsealed elsewhere and this signer kept its seal
  vault:seal --break-glass --reason <text> [--share <t>]...
                               Seal the vault at once with k escrow shares, without the dual-control proposal
`;

async function readShares(): Promise<string[]> {
  if (process.stdin.isTTY) process.stderr.write('Paste one share per line, then an empty line:\n');
  const rl = createInterface({ input: process.stdin, terminal: false });
  const out: string[] = [];
  for await (const line of rl) {
    if (!line.trim()) break;
    out.push(line.trim());
  }
  rl.close();
  return out;
}

export async function vaultSealCommand(s: Services, cmd: string, argv: string[], out: (t: string) => void, input: () => Promise<string[]> = readShares): Promise<number> {
  const actor = { service: 'cli' };
  try {
    if (cmd === 'vault:seal-status') {
      const st = await s.vaultSeal.publicStatus();
      const full = await s.vaultSeal.status(null);
      out(JSON.stringify({ sealed: st.sealed, ...(st.sealed ? { since: (st as { since?: number }).since ?? null, escrow: (st as { escrow?: unknown }).escrow ?? null } : {}), sealable: full.sealable, problem: full.problem, escrow: full.escrow, last: full.last }, null, 2) + '\n');
      return 0;
    }
    if (cmd === 'vault:unseal') {
      const { values } = parseArgs({ args: argv, options: { share: { type: 'string', multiple: true }, check: { type: 'string' }, 'signer-only': { type: 'boolean' } } });
      const shares = values.share?.length ? values.share : await input();
      if (!shares.length) throw new Error('No shares given (--share, or one per line on stdin).');
      if (values['signer-only']) {
        await s.vaultSeal.unsealSigner(shares, actor);
        out('The signer on this host is unsealed.\n');
        return 0;
      }
      await s.vaultSeal.unsealWith(shares, actor, null, values.check?.trim().toLowerCase() ?? null);
      out('The vault is unsealed. Every instance reopens its keys (at once over Redis, otherwise within a few seconds).\n');
      return 0;
    }
    if (cmd === 'vault:seal') {
      const { values } = parseArgs({ args: argv, options: { 'break-glass': { type: 'boolean' }, reason: { type: 'string' }, share: { type: 'string', multiple: true } } });
      if (!values['break-glass']) throw new Error('From the command line the vault is sealed only with --break-glass and k escrow shares. Otherwise propose it on the Platform screen (Vault seal), for a second platform admin to approve.');
      if (!values.reason || values.reason.trim().length < 10) throw new Error('--reason <text> (at least 10 characters) is required.');
      const shares = values.share?.length ? values.share : await input();
      await s.vaultSeal.breakGlass(shares, values.reason.trim(), actor);
      out('The vault is sealed on every instance. Unseal it with exprsn-ai vault:unseal and k shares.\n');
      return 0;
    }
    out(VAULT_SEAL_USAGE);
    return 64;
  } catch (err) {
    const msg = err instanceof HttpProblem ? (err.detail ?? err.title) : (err as Error).message;
    out(`error: ${msg}\n`);
    return err instanceof HttpProblem && err.status === 409 ? 3 : 2;
  }
}
