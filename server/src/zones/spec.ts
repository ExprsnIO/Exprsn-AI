import { BlockList, isIP } from 'node:net';
import { z } from 'zod';
import { labelRank, LABELS, type Label } from '../authz/labels.js';

/** Zone ids double as Kubernetes namespaces, Compose network names and nftables table suffixes. */
export const ZONE_ID = /^[a-z][a-z0-9-]{0,30}$/;
export const EXTERNAL_ZONE = 'external';
/** Path segments of the zone routes that cannot be zone ids. */
export const RESERVED_IDS = ['seed', 'rendered'];
export const TRANSPORTS = ['vpc-peering', 'wireguard', 'ipsec', 'direct'] as const;

/** The highest label the external zone may ever carry ("capped at internal"). */
export const EXTERNAL_CAP: Label = 'internal';

const cidr = z
  .string()
  .trim()
  .max(50)
  .refine((v) => parseCidr(v) !== null, 'An IPv4 or IPv6 CIDR such as 10.40.0.0/16');
const port = z.number().int().min(1).max(65535);
const zoneRef = z.string().regex(ZONE_ID, 'A zone id');

export const targetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('zone'), zone: zoneRef, ports: z.array(port).max(20).default([]) }).strict(),
  z.object({ kind: z.literal('cidr'), cidr, ports: z.array(port).max(20).default([]) }).strict(),
  z.object({ kind: z.literal('corporate'), ports: z.array(port).max(20).default([]) }).strict()
]);
export type Target = z.infer<typeof targetSchema>;

export const peerSchema = z.object({ zone: zoneRef, transport: z.enum(TRANSPORTS), mtls: z.enum(['required', 'optional']) }).strict();
export type Peer = z.infer<typeof peerSchema>;

const egressSchema = z.object({ mode: z.enum(['deny', 'allow-list']), allow: z.array(targetSchema).max(64).default([]), note: z.string().trim().max(200).nullable().default(null) }).strict();

/** The fields of a zone specification, without defaults (a patch names only what it changes). */
const fields = {
  /** What runs in the zone, in a few words (shown on the map). */
  contents: z.string().trim().max(200),
  trust: z.enum(['private', 'external']),
  cidrs: z.array(cidr).max(32),
  maxLabel: z.enum(LABELS),
  /** Where traffic into the zone may come from. */
  accepts: z.array(targetSchema).max(32),
  acceptsNote: z.string().trim().max(200).nullable(),
  egress: egressSchema,
  peers: z.array(peerSchema).max(32),
  /** Compose services (Kubernetes workloads) that run in this zone. */
  services: z.array(z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,62}$/, 'A Compose service name')).max(64)
};

export const specSchema = z
  .object({
    ...fields,
    contents: fields.contents.default(''),
    trust: fields.trust.default('private'),
    cidrs: fields.cidrs.default([]),
    accepts: fields.accepts.default([]),
    acceptsNote: fields.acceptsNote.default(null),
    egress: egressSchema.default({ mode: 'deny', allow: [], note: null }),
    peers: fields.peers.default([]),
    services: fields.services.default([])
  })
  .strict();
export type ZoneSpec = z.infer<typeof specSchema>;

/** A partial change merged over the zone's working specification. */
export const specPatchSchema = z.object(fields).partial().strict();
export type ZoneSpecPatch = z.infer<typeof specPatchSchema>;

// ---------- addresses ----------

export interface Cidr {
  family: 4 | 6;
  address: string;
  prefix: number;
  text: string;
}

export function parseCidr(text: string): Cidr | null {
  const m = /^([0-9a-fA-F:.]+)\/(\d{1,3})$/.exec(text.trim());
  if (!m) return null;
  const family = isIP(m[1]!);
  const prefix = Number(m[2]);
  if (family === 4 && prefix <= 32) return { family: 4, address: m[1]!, prefix, text: `${m[1]}/${prefix}` };
  if (family === 6 && prefix <= 128) return { family: 6, address: m[1]!.toLowerCase(), prefix, text: `${m[1]!.toLowerCase()}/${prefix}` };
  return null;
}

const PRIVATE: [string, number, 'ipv4' | 'ipv6'][] = [
  ['10.0.0.0', 8, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'],
  ['fc00::', 7, 'ipv6'],
  ['fe80::', 10, 'ipv6'],
  ['::1', 128, 'ipv6']
];
const privateRanges = PRIVATE.map(([addr, len, type]) => {
  const b = new BlockList();
  b.addSubnet(addr, len, type);
  return { b, len, type };
});

/** True when every address in the CIDR is private (RFC 1918, CGNAT, loopback, link-local, ULA): no internet route. */
export function isPrivateCidr(text: string): boolean {
  const c = parseCidr(text);
  if (!c) return false;
  const type = c.family === 4 ? 'ipv4' : 'ipv6';
  return privateRanges.some((r) => r.type === type && c.prefix >= r.len && r.b.check(c.address, type));
}

const v4 = (a: string) => a.split('.').reduce((n, x) => n * 256 + Number(x), 0);

/** IPv4 overlap between two CIDRs (IPv6 overlap is not checked). */
export function overlaps(a: string, b: string): boolean {
  const x = parseCidr(a);
  const y = parseCidr(b);
  if (!x || !y || x.family !== 4 || y.family !== 4) return false;
  const size = 2 ** (32 - Math.min(x.prefix, y.prefix));
  return Math.floor(v4(x.address) / size) === Math.floor(v4(y.address) / size);
}

// ---------- the zone set ----------

export interface ZoneSetMembers {
  /** Pool, connection, MCP server and endpoint names by zone id. */
  byZone: Map<string, { pools: string[]; connections: string[]; mcp: string[]; endpoints: string[] }>;
}

export interface SetProblem {
  zone: string;
  field: string;
  message: string;
}

export const isExternal = (id: string, spec: ZoneSpec) => id === EXTERNAL_ZONE || spec.trust === 'external';

const linked = (zones: Map<string, ZoneSpec>, a: string, b: string) => !!zones.get(a)?.peers.some((p) => p.zone === b) || !!zones.get(b)?.peers.some((p) => p.zone === a);

export const targetText = (t: Target): string =>
  (t.kind === 'zone' ? t.zone : t.kind === 'cidr' ? t.cidr : 'corporate network') + (t.ports.length ? ` (${t.ports.join(', ')})` : '');

/**
 * Checks a whole zone set (current versions, with a draft substituted when one is being reviewed): references,
 * peer links for every zone-to-zone rule, the external zone staying empty and capped, private addresses only in an
 * air-gapped posture, overlapping CIDRs and services claimed by two zones.
 */
export function validateSet(zones: Map<string, ZoneSpec>, members: ZoneSetMembers, airGapped: boolean): SetProblem[] {
  const out: SetProblem[] = [];
  const service = new Map<string, string>();
  for (const [id, spec] of zones) {
    const add = (field: string, message: string) => out.push({ zone: id, field, message });
    const ext = isExternal(id, spec);
    for (const p of spec.peers) {
      if (p.zone === id) add('peers', `${id} cannot peer with itself.`);
      else if (!zones.has(p.zone)) add('peers', `Peer ${p.zone} is not a defined zone.`);
    }
    const checkTargets = (field: 'accepts' | 'egress', list: Target[]) => {
      for (const t of list) {
        if (t.kind === 'zone') {
          if (t.zone === id) add(field, `Traffic inside a zone is always allowed; remove ${id} from the list.`);
          else if (!zones.has(t.zone)) add(field, `${t.zone} is not a defined zone.`);
          else if (!linked(zones, id, t.zone)) add(field, `${id} and ${t.zone} are not peers. Add a peer with its transport and mTLS first.`);
          else if (airGapped && isExternal(t.zone, zones.get(t.zone)!)) add(field, `${t.zone} is the external zone. In an air-gapped deployment no zone talks to it.`);
          else if (field === 'egress' && !zones.get(t.zone)!.accepts.some((a) => a.kind === 'zone' && a.zone === id)) add(field, `${id} sends to ${t.zone}, but ${t.zone} does not accept traffic from ${id}.`);
        }
        if (t.kind === 'cidr' && airGapped && !isPrivateCidr(t.cidr)) add(field, `${t.cidr} is not a private address range. In an air-gapped deployment no zone has internet ${field === 'egress' ? 'egress' : 'ingress'}.`);
      }
    };
    checkTargets('accepts', spec.accepts);
    if (spec.egress.mode === 'deny' && spec.egress.allow.length) add('egress', 'Egress is deny; remove the allow-list entries or switch to allow-list.');
    if (spec.egress.mode === 'allow-list' && !spec.egress.allow.length) add('egress', 'An allow-list needs at least one destination; otherwise use deny.');
    checkTargets('egress', spec.egress.allow);
    for (const c of spec.cidrs) {
      if (!ext && airGapped && !isPrivateCidr(c)) add('cidrs', `${c} is not a private address range.`);
    }
    for (const s of spec.services) {
      const other = service.get(s);
      if (other) add('services', `${s} already runs in ${other}. Every service belongs to exactly one zone.`);
      else service.set(s, id);
    }
    if (ext) {
      if (labelRank(spec.maxLabel) > labelRank(EXTERNAL_CAP)) add('maxLabel', `The external zone is capped at ${EXTERNAL_CAP}.`);
      const m = members.byZone.get(id);
      const names = m ? [...m.pools.map((x) => `pool ${x}`), ...m.connections.map((x) => `connection ${x}`), ...m.mcp.map((x) => `MCP server ${x}`), ...m.endpoints.map((x) => `endpoint ${x}`)] : [];
      if (spec.services.length) names.push(...spec.services.map((x) => `service ${x}`));
      if (names.length) add('members', `The external zone stays empty, but it holds ${names.join(', ')}. No pool, connection or service can be placed in it.`);
      if (airGapped) {
        if (spec.egress.mode !== 'deny') add('egress', 'The external zone has no egress in an air-gapped deployment.');
        if (spec.accepts.length) add('accepts', 'The external zone accepts nothing in an air-gapped deployment.');
        if (spec.peers.length) add('peers', 'The external zone has no peers in an air-gapped deployment.');
      }
    }
  }
  const all = [...zones].flatMap(([id, s]) => s.cidrs.map((c) => ({ id, c })));
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      if (all[i]!.id !== all[j]!.id && overlaps(all[i]!.c, all[j]!.c)) out.push({ zone: all[j]!.id, field: 'cidrs', message: `${all[j]!.c} overlaps ${all[i]!.c} in ${all[i]!.id}.` });
    }
  }
  return out;
}

// ---------- defaults ----------

const zoneT = (zone: string, ports: number[] = []): Target => ({ kind: 'zone', zone, ports });
const peer = (zone: string, transport: Peer['transport'] = 'vpc-peering'): Peer => ({ zone, transport, mtls: 'required' });

/**
 * The default zone set, from the Zones board, adapted to the services in deploy/docker/compose.yml (app, postgres,
 * redis, ollama). Offered by the "Seed default zones" action; never applied behind an administrator's back.
 */
export const DEFAULT_ZONES: { id: string; spec: ZoneSpec }[] = [
  { id: 'edge', spec: { contents: 'ingress, TLS termination, WAF', trust: 'private', cidrs: ['10.10.0.0/24'], maxLabel: 'restricted', accepts: [{ kind: 'corporate', ports: [443] }], acceptsNote: 'corporate network only', egress: { mode: 'allow-list', allow: [zoneT('app', [8080])], note: null }, peers: [peer('app')], services: [] } },
  { id: 'app', spec: { contents: 'web, api, identity, gateway, workers', trust: 'private', cidrs: ['10.20.0.0/22'], maxLabel: 'restricted', accepts: [zoneT('edge', [8080])], acceptsNote: null, egress: { mode: 'allow-list', allow: [zoneT('data', [5432, 6379]), zoneT('directory', [389, 636, 88]), zoneT('inference', [11434]), zoneT('sandbox')], note: null }, peers: [peer('data'), peer('directory'), peer('inference', 'wireguard'), peer('sandbox')], services: ['app'] } },
  { id: 'data', spec: { contents: 'PostgreSQL, Redis, object storage', trust: 'private', cidrs: ['10.30.0.0/24'], maxLabel: 'restricted', accepts: [zoneT('app', [5432, 6379]), zoneT('training', [5432, 9000])], acceptsNote: null, egress: { mode: 'deny', allow: [], note: null }, peers: [], services: ['postgres', 'redis'] } },
  { id: 'directory', spec: { contents: 'OpenLDAP, Kerberos KDC', trust: 'private', cidrs: ['10.31.0.0/24'], maxLabel: 'restricted', accepts: [zoneT('app', [389, 636, 88])], acceptsNote: 'identity and services binding via GSSAPI', egress: { mode: 'deny', allow: [], note: null }, peers: [], services: [] } },
  { id: 'inference', spec: { contents: 'Ollama pools, image workers', trust: 'private', cidrs: ['10.40.0.0/16'], maxLabel: 'confidential', accepts: [zoneT('app', [11434])], acceptsNote: 'inference gateway only', egress: { mode: 'deny', allow: [], note: null }, peers: [peer('app', 'wireguard')], services: ['ollama'] } },
  { id: 'sandbox', spec: { contents: 'tool runners, MCP, scripts, media', trust: 'private', cidrs: ['10.50.0.0/24'], maxLabel: 'confidential', accepts: [zoneT('app')], acceptsNote: null, egress: { mode: 'deny', allow: [], note: null }, peers: [peer('app')], services: [] } },
  { id: 'training', spec: { contents: 'GPU trainers', trust: 'private', cidrs: ['10.60.0.0/24'], maxLabel: 'confidential', accepts: [], acceptsNote: 'nothing: trainers take work from the job queue in data', egress: { mode: 'allow-list', allow: [zoneT('data', [5432, 9000])], note: null }, peers: [peer('data', 'wireguard')], services: [] } },
  { id: EXTERNAL_ZONE, spec: { contents: 'empty in an air-gapped site', trust: 'external', cidrs: [], maxLabel: 'internal', accepts: [], acceptsNote: null, egress: { mode: 'deny', allow: [], note: null }, peers: [], services: [] } }
];
