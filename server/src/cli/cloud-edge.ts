import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { cloudAudit } from '../cloud/audit.js';
import type { Services } from '../services.js';

/*
 * 1.9.99-final, Sprint 61 (B-10902): `exprsn-ai cloud:tunnel-token`, the one way a front door's tunnel token leaves the
 * vault: written to a new file with mode 0600 for the connector (a systemd credential, a Compose secret, the file a
 * Kubernetes Secret is made from), never printed. Every read is audited.
 */

export const CLOUD_EDGE_USAGE = `  cloud:tunnel-token           1.9.99-final: write a Cloudflare front door's tunnel token from the vault to a new
      --edge <name> --out <file>   file (mode 0600) for cloudflared; it is never printed
`;

export async function cloudTunnelTokenCommand(s: Services, args: string[], write: (t: string) => void): Promise<number> {
  const { values } = parseArgs({ args, options: { edge: { type: 'string' }, out: { type: 'string' } } });
  if (!values.edge || !values.out) {
    write(CLOUD_EDGE_USAGE);
    return 64;
  }
  const token = await s.cloud.edge.tunnelToken(values.edge);
  // `wx`: an existing file is never overwritten (a token in the wrong place stays visible to its owner only).
  writeFileSync(values.out, token, { mode: 0o600, flag: 'wx' });
  const tenant = await s.tenants.bySlug(s.cfg.DEFAULT_TENANT);
  if (tenant) await cloudAudit(s, { tenantId: tenant.id, action: 'cloud.edge.token.written', actor: { service: 'cli' }, detail: { edge: values.edge, file: values.out } });
  write(`Wrote the tunnel token of ${values.edge} to ${values.out} (mode 0600).\n`);
  return 0;
}
