import { isIP } from 'node:net';
import type { DesiredResource, GraphResource, PlanStep } from './graph.js';
import { CloudProviderError, type ResourceSpec } from './providers/types.js';
import type { Provider } from './types.js';

/*
 * 1.9.99-final, Sprint 58 (B-10206): a DNS record whose value comes from another resource's observed address
 * (`spec.valueFrom: { key, field }`, as `renderGraph` writes the front door's record: `{ key: 'lb', field: 'address' }`).
 *
 * - Order: the source is a dependency of the record (`withValueSources`), so the planner orders the record after it
 *   and the apply creates it once the source exists.
 * - Plan: the record is compared with the source's address as the provider reports it now (`resolveForDiff`); while
 *   the source has none (not created yet), the values are not compared. When the source is created or replaced in the
 *   same plan, an existing record is updated after it (`followSources`), since its address may change.
 * - Apply: the values are filled in from the source's row as the apply just stored it (`resolveSpec`); a source with
 *   no address yet fails the step with `value_source_pending` and the reason.
 *
 * A CNAME whose source reports an IP address is written as an A (or AAAA) record: DigitalOcean load balancers have an
 * address, AWS and Azure ones a name.
 */

export interface ValueFrom {
  key: string;
  field: string;
}

/** The fields an address may be reported under when `field` is `address`. */
const ADDRESS_FIELDS = ['address', 'dnsName', 'hostname', 'fqdn', 'ip', 'ipAddress', 'publicIp'];

export function valueFromOf(r: Pick<DesiredResource, 'spec'>): ValueFrom | null {
  const v = (r.spec as { valueFrom?: unknown }).valueFrom as Partial<ValueFrom> | undefined;
  return v && typeof v.key === 'string' && v.key ? { key: v.key, field: typeof v.field === 'string' && v.field ? v.field : 'address' } : null;
}

/** The desired graph with every value source made a dependency (only sources the graph holds). */
export function withValueSources(desired: DesiredResource[]): DesiredResource[] {
  const keys = new Set(desired.map((r) => r.key));
  return desired.map((r) => {
    const v = valueFromOf(r);
    if (!v || !keys.has(v.key) || v.key === r.key || (r.dependsOn ?? []).includes(v.key)) return r;
    return { ...r, dependsOn: [...(r.dependsOn ?? []), v.key] };
  });
}

/** The address a resource reports for a field, or null. */
export function observedValue(row: (Pick<GraphResource, 'observed'> & { locator?: Record<string, string> | null }) | null | undefined, field: string): string | null {
  const props = row?.observed?.props;
  if (!props) return null;
  // A cluster's load balancer (B-10203) may carry its address in the locator the deploy worker records.
  const locators = { ...(row?.locator ?? {}), ...(row?.observed?.locator ?? {}) } as Record<string, unknown>;
  for (const f of field === 'address' ? ADDRESS_FIELDS : [field]) {
    const v = props[f] ?? locators[f];
    const s = Array.isArray(v) ? v.find((x) => typeof x === 'string' && x) : v;
    if (typeof s === 'string' && s.trim()) return s.trim().replace(/\.$/, '');
  }
  return null;
}

/** A record's spec with its values from the source's address (and a CNAME to an IP address made A or AAAA). */
function filled(spec: Record<string, unknown>, value: string): Record<string, unknown> {
  const type = spec.recordType;
  const ip = isIP(value);
  return { ...spec, values: [value], ...(type === 'CNAME' && ip ? { recordType: ip === 6 ? 'AAAA' : 'A' } : {}) };
}

/** The desired graph as the planner compares it: values from the sources' observed addresses, or left out while none. */
export function resolveForDiff(desired: DesiredResource[], current: GraphResource[]): DesiredResource[] {
  const rows = new Map(current.map((r) => [r.key, r]));
  return desired.map((r) => {
    const v = valueFromOf(r);
    if (!v || r.type !== 'dns_record') return r;
    const value = observedValue(rows.get(v.key), v.field);
    if (value) return { ...r, spec: filled(r.spec, value) };
    const { values: _values, ...rest } = r.spec as Record<string, unknown>;
    return { ...r, spec: rest };
  });
}

/** Records whose source is created or replaced by the plan are updated after it (a noop becomes an update). */
export function followSources(steps: PlanStep[], desired: DesiredResource[]): PlanStep[] {
  const fresh = new Set(steps.filter((s) => s.action === 'create' || s.action === 'replace').map((s) => s.key));
  const byKey = new Map(desired.map((r) => [r.key, r]));
  return steps.map((s) => {
    if (s.action !== 'noop') return s;
    const r = byKey.get(s.key);
    const v = r ? valueFromOf(r) : null;
    if (!v || !fresh.has(v.key)) return s;
    return { ...s, action: 'update', changes: [{ path: 'values', before: null, after: `the address of ${v.key}`, forcesReplace: false }], reason: `Its value comes from ${v.key}, which this plan ${steps.find((x) => x.key === v.key)?.action === 'replace' ? 'replaces' : 'creates'}.` };
  });
}

/** At apply: the adapter's spec with the record's values from the source's row; throws while the source has no address. */
export function resolveSpec(spec: ResourceSpec, desired: DesiredResource, rows: Map<string, Pick<GraphResource, 'observed'>>, provider: Provider): ResourceSpec {
  const v = valueFromOf(desired);
  if (!v || desired.type !== 'dns_record') return spec;
  const value = observedValue(rows.get(v.key), v.field);
  if (!value) throw new CloudProviderError(`${desired.key} takes its value from ${v.key}.${v.field}, which ${rows.has(v.key) ? 'reports no address yet' : 'is not in the graph'}.`, provider, 409, 'value_source_pending');
  const { valueFrom: _vf, ...props } = filled(spec.props as Record<string, unknown>, value);
  return { ...spec, props: props as ResourceSpec['props'] };
}
