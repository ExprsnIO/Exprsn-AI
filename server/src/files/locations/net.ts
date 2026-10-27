import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { promisify } from 'node:util';
import { Agent } from 'undici';
import { servicePolicy, toolAddressProblem } from '../../platform/egress.js';
import type { Services } from '../../services.js';
import { RemoteError, type AddressCheck } from './model.js';

/*
 * How a linked location reaches its host. Every address the name resolves to is checked; the connection then dials
 * the checked address, so a second DNS answer cannot point it elsewhere. HTTP connectors (S3, Azure, IPFS) use
 * `pinnedAgent` as their undici dispatcher; socket connectors (SFTP, FTP) call `resolveChecked` and connect to the
 * address it returns (TLS keeps the host name as `servername`).
 */

const lookupAll = promisify(dnsLookup) as (host: string, o: { all: true; verbatim: true }) => Promise<LookupAddress[]>;

/** The address check of a tenant: the operator's service allow-list for internal hosts, the tenant's list for public ones. */
export async function addressCheck(s: Services, tenantId: string): Promise<AddressCheck> {
  const policy = servicePolicy(s.cfg);
  const tenant = await s.integrations.allowList(tenantId);
  return (address, host) => toolAddressProblem(address, host, policy, tenant)?.replace('HTTP tools reach', 'Linked locations reach') ?? null;
}

/** Resolves `host`, checks every address, and returns the first (refused with a RemoteError of status 403). */
export async function resolveChecked(host: string, check: AddressCheck): Promise<{ address: string; family: 4 | 6 }> {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  let list: LookupAddress[];
  if (isIP(h)) list = [{ address: h, family: isIP(h) as 4 | 6 }];
  else {
    try {
      list = await lookupAll(h, { all: true, verbatim: true });
    } catch {
      throw new RemoteError(`${h} does not resolve.`);
    }
  }
  if (!list.length) throw new RemoteError(`${h} does not resolve.`);
  for (const a of list) {
    const problem = check(a.address, h);
    if (problem) throw new RemoteError(problem, 403);
  }
  return { address: list[0]!.address, family: list[0]!.family === 6 ? 6 : 4 };
}

/** An undici dispatcher whose every connection dials a checked address. Close it when the connector closes. */
export function pinnedAgent(check: AddressCheck, timeoutMs: number): Agent {
  return new Agent({
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
    connect: {
      timeout: timeoutMs,
      lookup: ((hostname: string, options: { all?: boolean }, cb: (err: Error | null, address: string | LookupAddress[], family?: number) => void) => {
        resolveChecked(hostname, check).then(
          (r) => (options?.all ? cb(null, [{ address: r.address, family: r.family }]) : cb(null, r.address, r.family)),
          (err: Error) => cb(Object.assign(err, { code: 'EREFUSED' }), '', 0)
        );
      }) as never
    }
  });
}
