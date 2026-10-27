/*
 * 1.9.99-final, Sprint 61 (B-10901): Cloudflare's published egress ranges, the addresses its edge connects to an
 * origin from. Behind the Cloudflare front door (TRUST_PROXY with `cloudflare`), `CF-Connecting-IP` is believed only
 * from a peer in these ranges or from the tunnel's connector (CLOUDFLARE_TUNNEL_PEERS); `http/client-address.ts`.
 *
 * This is a maintained list, shipped as data: nothing fetches it at start or in tests. `asOf` is the day it was last
 * compared with Cloudflare's own publication (https://www.cloudflare.com/ips-v4, https://www.cloudflare.com/ips-v6,
 * and the API's `GET /client/v4/ips`); `GET /api/admin/cloud/edge/ranges?accountId=` compares it with the API again
 * through a Cloudflare account and names what was added or removed. When Cloudflare publishes a new range before a
 * release carries it, CLOUDFLARE_IP_RANGES replaces the list (comma-separated ranges) until then. The suite fails
 * when `asOf` is more than 180 days old, so the list cannot quietly go stale.
 */
export const CLOUDFLARE_IP_RANGES = {
  asOf: '2026-10-21',
  source: 'https://www.cloudflare.com/ips-v4, https://www.cloudflare.com/ips-v6 (GET /client/v4/ips)',
  v4: [
    '173.245.48.0/20',
    '103.21.244.0/22',
    '103.22.200.0/22',
    '103.31.4.0/22',
    '141.101.64.0/18',
    '108.162.192.0/18',
    '190.93.240.0/20',
    '188.114.96.0/20',
    '197.234.240.0/22',
    '198.41.128.0/17',
    '162.158.0.0/15',
    '104.16.0.0/13',
    '104.24.0.0/14',
    '172.64.0.0/13',
    '131.0.72.0/22'
  ],
  v6: ['2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32']
} as const;

/** Every shipped range, IPv4 first. */
export const cloudflareRanges = (): string[] => [...CLOUDFLARE_IP_RANGES.v4, ...CLOUDFLARE_IP_RANGES.v6];
