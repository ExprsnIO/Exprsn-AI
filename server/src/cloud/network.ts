import type { Label } from '../authz/labels.js';
import { zoneRules, type RenderContext, type RenderZone, type ZoneRule } from '../zones/render.js';
import { isPrivateCidr, parseCidr, type ZoneSpec } from '../zones/spec.js';
import type { DesiredResource } from './graph.js';
import type { FirewallRule } from './providers/types.js';
import type { DeployProvider, DeploymentSpec } from './spec.js';
import { SIZE_PRESETS, within } from './spec.js';

export { within } from './spec.js';

/*
 * 1.9.99-final, Sprint 57 (B-10202): the network foundation of a deployment, rendered from the zone specs.
 *
 * - One private network (an AWS VPC or an Azure virtual network) with a private subnet per zone and availability zone,
 *   carved from the spec's `network.cidr`; DigitalOcean VPCs have no subnets, so there each zone gets its own VPC,
 *   peered as the zones are. A zone whose own CIDRs already lie inside the network keeps them.
 * - One firewall per zone (security group, NSG, cloud firewall) whose rules are the zone's rules: `zoneRules` in
 *   `zones/render.ts`, the same model the nftables rendering prints, read against the zone set with the deployed zones
 *   addressed by their subnets. A zone this deployment does not place (an on-prem directory, say) keeps its own CIDRs.
 *   So the cloud firewall of a zone equals what `renderNftables` renders for that zone's hosts, rule for rule.
 * - NAT for zones whose egress allow-list reaches a public range; none otherwise (deny egress stays deny).
 * - The data tier's subnets are private only; its resources get private endpoints (`dataPlacement`), and
 *   `publicDataProblems` is the check that no data resource has a public address.
 *
 * Pure: nothing here calls a provider or the database.
 */

export const TIERS = ['edge', 'app', 'data', 'inference'] as const;
export type Tier = (typeof TIERS)[number];
/** Resource types that hold data: never a public address (B-10202). */
export const DATA_TYPES = ['database', 'cache', 'bucket'] as const;

export interface EgressRule {
  protocol: FirewallRule['protocol'];
  ports?: string;
  destinations: string[];
  description?: string;
}

/** The rules of one zone's firewall, in the adapters' shape. */
export interface ZoneFirewall {
  zone: string;
  key: string;
  ingress: FirewallRule[];
  egress: EgressRule[];
  egressDenied: boolean;
}

export interface NetworkRender {
  resources: DesiredResource[];
  /** The zones this deployment places, with their subnets (or DigitalOcean VPCs) and addresses. */
  placement: Record<Tier, { zone: string; cidrs: string[]; subnets: string[]; network: string; firewall: string } | null>;
  firewalls: ZoneFirewall[];
  /** The zone set as the deployment addresses it: what `renderNftables` reads to render the same rules for hosts. */
  context: RenderContext;
}

const AZ = ['a', 'b', 'c'] as const;
const v4 = (a: string) => a.split('.').reduce((n, x) => n * 256 + Number(x), 0);
const ip = (n: number) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');

/** The `i`th block of `prefix` bits inside `cidr`. */
function block(cidr: string, prefix: number, i: number): string {
  const c = parseCidr(cidr)!;
  const base = Math.floor(v4(c.address) / 2 ** (32 - c.prefix)) * 2 ** (32 - c.prefix);
  return `${ip(base + i * 2 ** (32 - prefix))}/${prefix}`;
}

/** The adapters' firewall rules for the zone's ingress rules: one rule per port (TCP), or every protocol when the zone names no port. */
export function ingressRules(rules: ZoneRule[]): FirewallRule[] {
  const out: FirewallRule[] = [];
  for (const r of rules) {
    const sources = r.cidrs.map((c) => c.text);
    if (!sources.length) continue; // as the nftables rendering: no CIDRs, nothing rendered
    if (!r.ports.length) out.push({ protocol: 'all', sources, description: r.label });
    else for (const p of r.ports) out.push({ protocol: 'tcp', ports: String(p), sources, description: r.label });
  }
  return out;
}

export function egressRules(rules: ZoneRule[]): EgressRule[] {
  const out: EgressRule[] = [];
  for (const r of rules) {
    const destinations = r.cidrs.map((c) => c.text);
    if (!destinations.length) continue;
    if (!r.ports.length) out.push({ protocol: 'all', destinations, description: r.label });
    else for (const p of r.ports) out.push({ protocol: 'tcp', ports: String(p), destinations, description: r.label });
  }
  return out;
}

export interface NetworkInput {
  spec: DeploymentSpec;
  provider: DeployProvider;
  region: string;
  /** The current zone set (`s.zones.current()`), and the corporate network (ZONES_CORPORATE_CIDRS). */
  zones: Map<string, { version: number; spec: ZoneSpec }>;
  corporateCidrs: string[];
}

/** The tiers a spec places: the edge and the app always, the data tier when provisioned, inference for GPU pools. */
export function tiersOf(spec: DeploymentSpec): Tier[] {
  return TIERS.filter((t) => t === 'edge' || t === 'app' || (t === 'data' && spec.data.mode === 'provision') || (t === 'inference' && spec.gpuPools.length > 0));
}

/**
 * Renders the network foundation (B-10202): networks, subnets and firewalls as desired resources, the placement of
 * each tier, the firewalls' rules and the zone context they were read against.
 */
export function renderNetwork(input: NetworkInput): NetworkRender {
  const { spec, provider } = input;
  const preset = SIZE_PRESETS[spec.compute.size];
  const tiers = tiersOf(spec);
  const azs = provider === 'digitalocean' ? 1 : preset.azs;
  const net = parseCidr(spec.network.cidr)!;
  const sub = Math.min(28, net.prefix + 4); // 16 blocks: four zones times up to three availability zones fit

  // The deployed zones' addresses: their own CIDRs when they lie inside the network, else blocks carved from it.
  const placed = new Map<string, { tier: Tier; cidrs: string[] }>();
  tiers.forEach((tier, ti) => {
    const zone = spec.zones[tier];
    if (placed.has(zone)) return; // two tiers in one zone share its subnets
    const own = input.zones.get(zone)?.spec.cidrs.filter((c) => parseCidr(c)?.family === 4) ?? [];
    const cidrs = own.length && own.every((c) => within(c, spec.network.cidr)) ? own : Array.from({ length: azs }, (_, a) => block(spec.network.cidr, sub, ti * 3 + a));
    placed.set(zone, { tier, cidrs });
  });

  // The zone set as this deployment addresses it.
  const zones = new Map<string, RenderZone>();
  for (const [id, z] of input.zones) {
    const p = placed.get(id);
    zones.set(id, { id, version: z.version, spec: p ? { ...z.spec, cidrs: p.cidrs } : z.spec });
  }
  const context: RenderContext = { zones, corporateCidrs: input.corporateCidrs };

  const resources: DesiredResource[] = [];
  const firewalls: ZoneFirewall[] = [];
  const placement = Object.fromEntries(TIERS.map((t) => [t, null])) as NetworkRender['placement'];
  const needsNat = (z: ZoneSpec) => z.egress.mode === 'allow-list' && z.egress.allow.some((t) => t.kind === 'cidr' && !isPrivateCidr(t.cidr));
  const publicEdge = spec.frontDoor.kind !== 'cloudflare'; // a Cloudflare Tunnel dials out; the others need an internet-facing load balancer
  const anyNat = [...placed.keys()].some((id) => {
    const z = zones.get(id);
    return z ? needsNat(z.spec) : false;
  });

  if (provider !== 'digitalocean') {
    resources.push({ key: 'net', type: 'network', spec: { cidr: spec.network.cidr, nat: anyNat ? 'gateway' : 'none', internetGateway: publicEdge, dnsHostnames: true }, dependsOn: [], protect: false, region: null });
  }
  for (const [zoneId, p] of placed) {
    const z = zones.get(zoneId)!;
    const rules = zoneRules(z, context);
    const fwKey = `fw-${zoneId}`.slice(0, 63);
    const netKey = provider === 'digitalocean' ? `net-${zoneId}`.slice(0, 63) : 'net';
    const subnets: string[] = [];
    if (provider === 'digitalocean') {
      const peers = z.spec.peers.map((x) => x.zone).filter((x) => placed.has(x)).map((x) => `net-${x}`);
      resources.push({ key: netKey, type: 'network', spec: { cidr: p.cidrs[0]!, zone: zoneId, peers }, dependsOn: [], protect: false, region: null });
    } else {
      p.cidrs.forEach((cidr, i) => {
        const key = `subnet-${zoneId}-${AZ[i] ?? i}`.slice(0, 63);
        subnets.push(key);
        const isPublic = p.tier === 'edge' && publicEdge;
        resources.push({
          key,
          type: 'subnet',
          spec: { cidr, zone: provider === 'aws' ? `${input.region}${AZ[i] ?? 'a'}` : String(i + 1), private: !isPublic, public: isPublic, egress: needsNat(z.spec) ? 'nat' : 'none', firewall: fwKey, exprsnZone: zoneId },
          dependsOn: [fwKey],
          protect: false,
          region: null,
          network: 'net'
        });
      });
    }
    const fw: ZoneFirewall = { zone: zoneId, key: fwKey, ingress: ingressRules(rules.ingress), egress: egressRules(rules.egress), egressDenied: rules.egressDenied };
    firewalls.push(fw);
    resources.push({
      key: fwKey,
      type: 'firewall',
      spec: { ingress: fw.ingress, egress: fw.egress, egressDenied: fw.egressDenied, description: `Exprsn-AI zone ${zoneId} v${z.version} (max label ${z.spec.maxLabel})`, exprsnZone: zoneId, zoneVersion: z.version },
      dependsOn: [],
      protect: false,
      region: null,
      network: netKey
    });
    for (const [tier, t] of Object.entries(spec.zones) as [Tier, string][]) {
      if (t === zoneId && tiers.includes(tier)) placement[tier] = { zone: zoneId, cidrs: p.cidrs, subnets, network: netKey, firewall: fwKey };
    }
  }
  return { resources, placement, firewalls, context };
}

/**
 * Where a data-tier resource goes: the data zone's network and private subnets, its firewall, and no public access
 * (a private endpoint on AWS and Azure, the VPC's private network on DigitalOcean).
 */
export function dataPlacement(render: NetworkRender): { network: string; subnets: string[]; firewall: string; publicAccess: false; privateEndpoint: true } | null {
  const p = render.placement.data;
  return p ? { network: p.network, subnets: p.subnets, firewall: p.firewall, publicAccess: false, privateEndpoint: true } : null;
}

/** Why a desired graph would give a data resource a public address (the check the plan refuses on), or none. */
export function publicDataProblems(resources: DesiredResource[]): string[] {
  const by = new Map(resources.map((r) => [r.key, r]));
  const out: string[] = [];
  for (const r of resources) {
    if (!(DATA_TYPES as readonly string[]).includes(r.type)) continue;
    const s = r.spec;
    if (s.publicAccess !== false) out.push(`${r.key} (${r.type}) does not turn public access off.`);
    if (s.publicAddress || s.publicIp || s.publiclyAccessible) out.push(`${r.key} (${r.type}) asks for a public address.`);
    if (r.type !== 'bucket') {
      if (!r.network) out.push(`${r.key} (${r.type}) is not placed in a private network.`);
      for (const k of (s.subnets as string[] | undefined) ?? []) {
        const sn = by.get(k);
        if (!sn || sn.type !== 'subnet') out.push(`${r.key} (${r.type}) names ${k}, which is not a subnet of the graph.`);
        else if (sn.spec.public === true || sn.spec.private === false) out.push(`${r.key} (${r.type}) is placed in ${k}, a public subnet.`);
      }
    }
  }
  return out;
}

/** The label a zone's firewall protects (for the plan's notes). */
export const zoneLabel = (render: NetworkRender, zone: string): Label | null => render.context.zones.get(zone)?.spec.maxLabel ?? null;
