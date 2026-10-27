import { parseArgs } from 'node:util';
import { PUSH_KINDS, type PushKind } from '../push/model.js';
import type { Services } from '../services.js';

/*
 * 1.9.0 (B-154): `exprsn-ai push:test --user <username> [--kind <kind>] [--tenant <slug>]`: a test notification to a
 * person's active devices, each through the provider it would use (the tenant's, else the platform's), sent at once.
 * Prints one line per device with the outcome, status and the provider's reason; never a token or a credential. The
 * attempts are in the delivery log as tests, and `push.test.sent` is audited with the CLI as the actor.
 */

export const PUSH_USAGE = `  push:test --user <username> [--kind apns|fcm|webpush|http|websocket] [--tenant <slug>]
                               1.9.0 (B-154): send a test notification to a person's devices through their providers
                               and print each outcome (exit 2 when none was sent)
`;

export async function pushTestCommand(s: Services, argv: string[], out: (t: string) => void): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { user: { type: 'string' }, kind: { type: 'string' }, tenant: { type: 'string' } } });
  if (!values.user) {
    out(`Usage:\n${PUSH_USAGE}`);
    return 64;
  }
  if (values.kind && !(PUSH_KINDS as readonly string[]).includes(values.kind)) throw new Error(`--kind is one of ${PUSH_KINDS.join(', ')}`);
  const tenant = await s.tenants.bySlug(values.tenant ?? s.cfg.DEFAULT_TENANT);
  if (!tenant) throw new Error('Unknown tenant');
  const user = await s.users.byUsername(tenant.id, values.user.trim().toLowerCase());
  if (!user) throw new Error(`No user ${values.user} in ${tenant.slug}`);
  const r = await s.push.testUser(tenant.id, user.id, values.kind ? { kind: values.kind as PushKind } : {});
  if (!r.results.length) {
    out(`${user.username} has no active devices${values.kind ? ` of kind ${values.kind}` : ''}.\n`);
    return 2;
  }
  for (const x of r.results) out(`${x.name ?? x.deviceId}: ${x.outcome}${x.status ? ` ${x.status}` : ''}${x.reason ? ` (${x.reason})` : ''}${x.provider ? ` via ${x.provider}` : ''}, ${x.latencyMs} ms\n`);
  return r.results.some((x) => x.outcome === 'sent') ? 0 : 2;
}
