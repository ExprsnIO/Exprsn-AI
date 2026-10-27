import { isExternal, parseCidr, type Target, type ZoneSpec } from './spec.js';

/**
 * Renders zone definitions into the configuration the deploy targets use:
 *
 * - `networkpolicy`: a Namespace and a default-deny Kubernetes NetworkPolicy per zone (namespace = zone id, pods
 *   selected by the `exprsn.ai/zone` namespace label), for the Helm deployment.
 * - `compose`: one Docker network per zone and each service's networks (its own zone plus every zone it may send
 *   to), matching deploy/docker/compose.yml; a zone with deny egress gets an `internal: true` network.
 * - `nftables`: an inet table per zone for bare-metal hosts in the zone's CIDRs (deploy/baremetal), default drop,
 *   with the accepted sources and allowed destinations.
 *
 * The output is deterministic, so two renderings diff line by line.
 */
export const FORMATS = ['networkpolicy', 'compose', 'nftables'] as const;
export type Format = (typeof FORMATS)[number];

export interface RenderZone {
  id: string;
  version: number;
  spec: ZoneSpec;
  draft?: boolean;
}

export interface RenderContext {
  zones: Map<string, RenderZone>;
  corporateCidrs: string[];
}

const portsOf = (t: Target) => [...new Set(t.ports)].sort((a, b) => a - b);
const versionText = (z: RenderZone) => `v${z.version}${z.draft ? ' (draft)' : ''}`;

// ---------- NetworkPolicy ----------

function npPeers(t: Target, ctx: RenderContext): string[] {
  if (t.kind === 'zone') return [`        - namespaceSelector: {matchLabels: {exprsn.ai/zone: ${t.zone}}}`];
  if (t.kind === 'cidr') return [`        - ipBlock: {cidr: ${t.cidr}}`];
  return ctx.corporateCidrs.map((c) => `        - ipBlock: {cidr: ${c}}`);
}

function npRule(dir: 'from' | 'to', t: Target, ctx: RenderContext): string[] {
  const peers = npPeers(t, ctx);
  if (!peers.length) return ['    # corporate network: ZONES_CORPORATE_CIDRS is not set, so nothing is admitted from it'];
  const out = [`    - ${dir}:`, ...peers];
  const ports = portsOf(t);
  if (ports.length) out.push('      ports:', ...ports.map((p) => `        - {port: ${p}, protocol: TCP}`));
  return out;
}

export function renderNetworkPolicy(z: RenderZone, ctx: RenderContext): string {
  const s = z.spec;
  const head = `# NetworkZone ${z.id} ${versionText(z)}, max label ${s.maxLabel}`;
  if (isExternal(z.id, s)) return `${head}\n# External zone: exists in the schema only. Nothing runs in it, so nothing is rendered.\n`;
  const lines = [
    head,
    'apiVersion: v1',
    'kind: Namespace',
    'metadata:',
    `  name: ${z.id}`,
    '  labels:',
    `    exprsn.ai/zone: ${z.id}`,
    `    exprsn.ai/max-label: ${s.maxLabel}`,
    '---',
    'apiVersion: networking.k8s.io/v1',
    'kind: NetworkPolicy',
    'metadata:',
    `  name: ${z.id}-zone`,
    `  namespace: ${z.id}`,
    '  labels:',
    `    exprsn.ai/zone: ${z.id}`,
    `    exprsn.ai/zone-version: "${z.version}"`,
    'spec:',
    '  podSelector: {}',
    '  policyTypes: [Ingress, Egress]',
    '  ingress:',
    '    - from:',
    '        - podSelector: {}'
  ];
  for (const t of s.accepts) lines.push(...npRule('from', t, ctx));
  lines.push(
    '  egress:',
    '    - to:',
    '        - podSelector: {}',
    '    - to:',
    '        - namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: kube-system}}',
    '          podSelector: {matchLabels: {k8s-app: kube-dns}}',
    '      ports:',
    '        - {port: 53, protocol: UDP}',
    '        - {port: 53, protocol: TCP}'
  );
  if (s.egress.mode === 'allow-list') for (const t of s.egress.allow) lines.push(...npRule('to', t, ctx));
  return lines.join('\n') + '\n';
}

// ---------- Compose ----------

/** The Compose fragment for some zones: their networks, and the networks of the services that run in them. */
export function renderCompose(list: RenderZone[], ctx: RenderContext): string {
  const lines: string[] = [];
  const zones = list.filter((z) => !isExternal(z.id, z.spec));
  lines.push(`# NetworkZones: ${list.map((z) => `${z.id} ${versionText(z)}`).join(', ')}`);
  if (!zones.length) return lines.concat(['# External zone: exists in the schema only; no network is rendered.']).join('\n') + '\n';
  lines.push('networks:');
  for (const z of zones) {
    const deny = z.spec.egress.mode === 'deny';
    lines.push(`  ${z.id}:`);
    lines.push(`    # max label ${z.spec.maxLabel}; ${deny ? 'egress denied' : 'egress allow-list, enforced by the host nftables rules'}`);
    if (deny) lines.push('    internal: true');
    lines.push('    driver: bridge');
    lines.push('    labels:');
    lines.push(`      exprsn.ai/zone: ${z.id}`);
    lines.push(`      exprsn.ai/zone-version: "${z.version}"`);
    const v4 = z.spec.cidrs.filter((c) => parseCidr(c)?.family === 4);
    if (v4.length) {
      lines.push('    ipam:', '      config:', ...v4.map((c) => `        - subnet: ${c}`));
    }
  }
  const services = zones.flatMap((z) => z.spec.services.map((svc) => ({ svc, z })));
  if (services.length) {
    lines.push('services:');
    for (const { svc, z } of services.sort((a, b) => a.svc.localeCompare(b.svc))) {
      const nets = [z.id];
      for (const t of z.spec.egress.mode === 'allow-list' ? z.spec.egress.allow : []) {
        if (t.kind === 'zone' && ctx.zones.has(t.zone) && !nets.includes(t.zone)) nets.push(t.zone);
      }
      lines.push(`  ${svc}:`, `    networks: [${nets.join(', ')}]`);
    }
  }
  return lines.join('\n') + '\n';
}

// ---------- nftables ----------

function addrs(t: Target, ctx: RenderContext): string[] {
  if (t.kind === 'zone') return ctx.zones.get(t.zone)?.spec.cidrs ?? [];
  if (t.kind === 'cidr') return [t.cidr];
  return ctx.corporateCidrs;
}

const tLabel = (t: Target) => (t.kind === 'zone' ? t.zone : t.kind === 'cidr' ? t.cidr : 'corporate network');

/**
 * One rule of a zone, as every address-based rendering reads it (nftables here, the cloud firewalls in
 * `cloud/network.ts`, 1.9.99-final B-10202): the peer's CIDRs (parsed, in the order given), the TCP ports (sorted,
 * none = every port) and the rule's label.
 */
export interface ZoneRule {
  label: string;
  /** The target the rule came from; null for the zone itself ("within <zone>"). */
  target: Target | null;
  cidrs: { family: 4 | 6; text: string }[];
  ports: number[];
}

/** The rule model of a zone: who may send to it (`ingress`, itself first) and where it may send (`egress`, itself first; deny egress keeps only itself). */
export function zoneRules(z: RenderZone, ctx: RenderContext): { ingress: ZoneRule[]; egress: ZoneRule[]; egressDenied: boolean } {
  const self = { kind: 'zone', zone: z.id, ports: [] } as Target;
  const rule = (t: Target, label: string, target: Target | null): ZoneRule => ({
    label,
    target,
    cidrs: addrs(t, ctx)
      .map((c) => parseCidr(c))
      .filter((c) => !!c)
      .map((c) => ({ family: c.family, text: c.text })),
    ports: portsOf(t)
  });
  const within = rule(self, `within ${z.id}`, null);
  const denied = z.spec.egress.mode !== 'allow-list';
  return {
    ingress: [within, ...z.spec.accepts.map((t) => rule(t, `from ${tLabel(t)}`, t))],
    egress: [within, ...(denied ? [] : z.spec.egress.allow.map((t) => rule(t, `to ${tLabel(t)}`, t)))],
    egressDenied: denied
  };
}

function nftRules(dir: 'saddr' | 'daddr', r: ZoneRule): string[] {
  if (!r.cidrs.length) return [`    # ${r.label}: no CIDRs defined, nothing rendered`];
  const tail = (r.ports.length ? ` tcp dport { ${r.ports.join(', ')} }` : '') + ` accept comment "${r.label}"`;
  const out: string[] = [];
  for (const fam of [4, 6] as const) {
    const set = r.cidrs.filter((c) => c.family === fam).map((c) => c.text);
    if (set.length) out.push(`    ${fam === 4 ? 'ip' : 'ip6'} ${dir} { ${set.join(', ')} }${tail}`);
  }
  return out;
}

export function renderNftables(z: RenderZone, ctx: RenderContext): string {
  const s = z.spec;
  const head = `# NetworkZone ${z.id} ${versionText(z)}, max label ${s.maxLabel}`;
  if (isExternal(z.id, s)) return `${head}\n# External zone: exists in the schema only. No host belongs to it, so no table is rendered.\n`;
  const rules = zoneRules(z, ctx);
  const lines = [
    head,
    `# For hosts in ${s.cidrs.length ? s.cidrs.join(', ') : '(no CIDRs defined)'}. Load with: nft -f ${z.id}.nft`,
    `table inet exprsn_zone_${z.id.replace(/-/g, '_')} {`,
    '  chain input {',
    '    type filter hook input priority 0; policy drop;',
    '    ct state established,related accept',
    '    ct state invalid drop',
    '    iif "lo" accept'
  ];
  for (const r of rules.ingress) lines.push(...nftRules('saddr', r));
  lines.push('  }', '  chain output {', '    type filter hook output priority 0; policy drop;', '    ct state established,related accept', '    oif "lo" accept');
  for (const r of rules.egress) lines.push(...nftRules('daddr', r));
  if (rules.egressDenied) lines.push('    # egress denied: nothing leaves the zone');
  lines.push('  }', '}');
  return lines.join('\n') + '\n';
}

export function render(format: Format, z: RenderZone, ctx: RenderContext): string {
  if (format === 'networkpolicy') return renderNetworkPolicy(z, ctx);
  if (format === 'compose') return renderCompose([z], ctx);
  return renderNftables(z, ctx);
}

/** Every zone of a set in one file, for download. */
export function renderAll(format: Format, ctx: RenderContext): string {
  const list = [...ctx.zones.values()];
  if (format === 'compose') return renderCompose(list, ctx);
  if (format === 'networkpolicy') return list.map((z) => renderNetworkPolicy(z, ctx)).join('---\n');
  return list.map((z) => renderNftables(z, ctx)).join('\n');
}

// ---------- diff ----------

export interface DiffResult {
  text: string;
  added: number;
  removed: number;
}

/** A line diff (longest common subsequence): lines prefixed with "+", "-" or a space. */
export function diffLines(before: string, after: string): DiffResult {
  const a = before.replace(/\n$/, '').split('\n');
  const b = after.replace(/\n$/, '').split('\n');
  if (!before) a.length = 0;
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: string[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      out.push(` ${a[i]}`);
      i++;
      j++;
    } else if (j < m && (i >= n || lcs[i]![j + 1]! > lcs[i + 1]![j]!)) {
      out.push(`+${b[j]}`);
      added++;
      j++;
    } else {
      out.push(`-${a[i]}`);
      removed++;
      i++;
    }
  }
  return { text: out.join('\n') + '\n', added, removed };
}
