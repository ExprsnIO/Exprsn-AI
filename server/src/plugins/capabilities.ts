/*
 * The closed capability vocabulary for plugins (B-2002), after exprsn-platform's plugins service. A manifest may only
 * ask for capabilities in this list; anything else refuses the manifest. Grants are a subset of what the manifest
 * asks for, and B-2003 (declarative actions) and B-2004 (script handlers) check each call against the grants.
 * Widening the list is a security decision: add an entry here, with its risk, in a reviewed change.
 *
 * Naming: `<verb>:<noun>`. `read` sees events and data, `emit` produces a side effect inside the tenant, `write`
 * changes tenant data (always through the guardrails), `call` reaches another subsystem.
 */

export interface Capability {
  name: string;
  description: string;
  /** `high` capabilities change data or reach out of the tenant: they are never granted implicitly. */
  risk: 'low' | 'high';
  /** Event groups a plugin holding this capability may subscribe to (read capabilities only). */
  events?: string[];
}

export const CAPABILITIES: readonly Capability[] = [
  { name: 'read:events', description: 'Receive the audit, job, flag and approval events the plugin subscribes to.', risk: 'low', events: ['job.*', 'flag.*', 'approval.*', 'workflow.*', 'agent.*', 'user.*', 'auth.*', 'authz.*', 'chat.*', 'conversation.*', 'billing.*', 'webhook.*', 'plugin.*'] },
  { name: 'read:records', description: 'Receive low-code record events and read records the installing tenant can see.', risk: 'low', events: ['record.*'] },
  { name: 'read:files', description: 'Receive file store events and read file metadata.', risk: 'low', events: ['file.*'] },
  { name: 'read:groups', description: 'Receive group and membership events.', risk: 'low', events: ['group.*'] },
  { name: 'read:messages', description: 'Receive message events (ids only; bodies stay sealed).', risk: 'low', events: ['message.*'] },
  { name: 'read:posts', description: 'Receive workspace feed events.', risk: 'low', events: ['post.*'] },
  { name: 'emit:log', description: "Write lines to the plugin's own log.", risk: 'low' },
  { name: 'emit:audit', description: "Append entries to the tenant's audit chain, attributed to the plugin.", risk: 'low' },
  { name: 'emit:notification', description: 'Send in-app notifications to users of the tenant.', risk: 'low' },
  { name: 'emit:flag', description: 'Raise a flag for human review (never acts on its own).', risk: 'low' },
  { name: 'call:webhook', description: 'Send events to an endpoint through the signed webhook delivery.', risk: 'high' },
  { name: 'call:workflow', description: 'Start a published workflow of the tenant.', risk: 'high' },
  { name: 'write:records', description: 'Create and update low-code records (through the guardrails).', risk: 'high' },
  { name: 'write:posts', description: 'Publish feed posts on behalf of the plugin (through the guardrails).', risk: 'high' }
];

const byName = new Map(CAPABILITIES.map((c) => [c.name, c]));

export const isCapability = (name: string): boolean => byName.has(name);
export const capability = (name: string): Capability | undefined => byName.get(name);
export const unknownCapabilities = (names: readonly string[]): string[] => names.filter((n) => !byName.has(n));

/**
 * The read capability an event pattern needs (`flag.*` needs `read:events`, `record.updated` needs `read:records`),
 * or null when no capability covers it. `*` needs every read capability.
 */
export function capabilitiesForPattern(pattern: string): string[] | null {
  if (pattern === '*') return CAPABILITIES.filter((c) => c.events).map((c) => c.name);
  for (const c of CAPABILITIES) {
    for (const g of c.events ?? []) {
      const prefix = g.slice(0, -1); // 'record.'
      if (pattern === g || pattern.startsWith(prefix)) return [c.name];
    }
  }
  return null;
}
