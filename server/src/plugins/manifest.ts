import { Ajv } from 'ajv';
import { z } from 'zod';
import { knownPattern } from '../events/catalogue.js';
import { isEventPattern } from '../webhooks/service.js';
import { scanSecrets } from '../registry/checks.js';
import { blockedModules } from '../scripts/service.js';
import { capabilitiesForPattern, capability, unknownCapabilities } from './capabilities.js';

/*
 * Plugin manifests (B-2002), after exprsn-platform's manifest validator: a structural check (zod, strict, so an
 * unknown field is refused), then the trust checks: every capability in the closed vocabulary, every event in the
 * catalogue (B-2001) and covered by a read capability, every declarative action covered by its capability, and the
 * configuration schema a JSON Schema that compiles. A manifest is data: nothing in it is ever loaded or run by the
 * server. Declarative actions run from B-2003 and script handlers in the sandbox from B-2004.
 *
 * 1.4.0 (Sprint 25, B-2003, B-2004): each action's `with` is checked against its own schema, and a script names its
 * language and an entry function the source declares; a source that uses network or process modules, or carries a
 * credential, is refused (the same checks as scripts).
 */

/** Declarative action types (B-2003) and the capability each needs. */
export const ACTION_CAPABILITY: Record<string, string> = {
  log: 'emit:log',
  audit: 'emit:audit',
  notify: 'emit:notification',
  flag: 'emit:flag',
  webhook: 'call:webhook',
  workflow: 'call:workflow'
};

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

const short = z.string().max(2000);
/** What each declarative action takes in `with`. Strings may use `{{event.type}}`, `{{event.data.flag}}`, `{{config.x}}`. */
export const ACTION_WITH: Record<string, z.ZodType> = {
  log: z.object({ message: short.optional(), level: z.enum(['info', 'warn', 'error']).optional() }).strict(),
  audit: z.object({ message: short.optional(), detail: z.record(z.string(), z.union([z.string().max(500), z.number(), z.boolean(), z.null()])).optional() }).strict(),
  notify: z.object({ title: z.string().max(200).optional(), body: short.optional(), roles: z.array(z.string().max(60)).max(20).optional(), users: z.array(z.string().max(26)).max(100).optional() }).strict(),
  flag: z.object({ reason: short.optional(), severity: z.enum(['low', 'medium', 'high']).optional() }).strict(),
  webhook: z.object({ url: z.string().url().max(2000).optional() }).strict(),
  workflow: z.object({ workflow: z.string().trim().min(1).max(200), input: z.record(z.string(), z.unknown()).optional(), includeEvent: z.boolean().optional() }).strict()
};

const IDENTIFIER: Record<'javascript' | 'python', RegExp> = { javascript: /^[A-Za-z_$][A-Za-z0-9_$]*$/, python: /^[A-Za-z_][A-Za-z0-9_]*$/ };

const action = z
  .object({
    type: z.string().min(1).max(40),
    on: z.string().trim().min(1).max(120).optional(),
    with: z.record(z.string(), z.unknown()).optional()
  })
  .strict();

export const manifestSchema = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/, 'a lowercase name: letters, digits and hyphens, 2 to 63 characters'),
    name: z.string().trim().min(1).max(100),
    version: z.string().regex(SEMVER, 'a semantic version such as 1.2.0'),
    description: z.string().max(2000).optional(),
    publisher: z.string().trim().max(200).optional(),
    homepage: z.string().url().max(500).optional(),
    kind: z.enum(['declarative', 'webhook', 'script']),
    events: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
    capabilities: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
    /** Capabilities the plugin works without; the rest must be granted before it can be enabled. */
    optionalCapabilities: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
    config: z.object({ schema: z.record(z.string(), z.unknown()) }).strict().optional(),
    actions: z.array(action).max(50).optional(),
    webhook: z.object({ url: z.string().url().max(2000) }).strict().optional(),
    script: z.object({ entry: z.string().trim().min(1).max(200), source: z.string().min(1).max(100_000), language: z.enum(['javascript', 'python']).optional() }).strict().optional()
  })
  .strict();

export type Manifest = z.infer<typeof manifestSchema>;

export class ManifestError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join('; '));
  }
}

const ajv = new Ajv({ strict: false, allErrors: true });

/** Parses and checks a manifest; throws `ManifestError` with every problem found. */
export function validateManifest(input: unknown): Manifest {
  const parsed = manifestSchema.safeParse(input);
  if (!parsed.success) throw new ManifestError(parsed.error.issues.map((i) => `${i.path.length ? i.path.join('.') : 'manifest'}: ${i.message}`));
  const m = parsed.data;
  const problems: string[] = [];
  const caps = new Set(m.capabilities);
  if (caps.size !== m.capabilities.length) problems.push('capabilities: each capability once');
  const unknown = unknownCapabilities(m.capabilities);
  if (unknown.length) problems.push(`capabilities: not in the capability vocabulary: ${unknown.join(', ')}`);
  for (const o of m.optionalCapabilities) if (!caps.has(o)) problems.push(`optionalCapabilities: ${o} is not among the capabilities`);
  for (const e of m.events) {
    if (!isEventPattern(e) || !knownPattern(e)) {
      problems.push(`events: ${e} is not in the event catalogue`);
      continue;
    }
    const need = capabilitiesForPattern(e);
    if (!need) problems.push(`events: no capability covers ${e}`);
    else {
      const missing = need.filter((c) => !caps.has(c));
      if (missing.length) problems.push(`events: ${e} needs ${missing.join(', ')}`);
    }
  }
  for (const [i, a] of (m.actions ?? []).entries()) {
    const need = ACTION_CAPABILITY[a.type];
    if (!need) problems.push(`actions.${i}.type: ${a.type} is not an action (${Object.keys(ACTION_CAPABILITY).join(', ')})`);
    else if (!caps.has(need)) problems.push(`actions.${i}: a ${a.type} action needs the ${need} capability`);
    const w = ACTION_WITH[a.type]?.safeParse(a.with ?? {});
    if (w && !w.success) for (const i2 of w.error.issues) problems.push(`actions.${i}.with${i2.path.length ? '.' + i2.path.join('.') : ''}: ${i2.message}`);
    if (a.on && !(isEventPattern(a.on) && m.events.some((e) => e === '*' || e === a.on || (e.endsWith('.*') && a.on!.startsWith(e.slice(0, -1)))))) problems.push(`actions.${i}.on: ${a.on} is not among the plugin's events`);
  }
  if (m.kind === 'declarative' && !m.actions?.length) problems.push('actions: a declarative plugin has at least one action');
  if (m.kind === 'webhook') {
    if (!m.webhook) problems.push('webhook: a webhook plugin names its endpoint');
    if (!caps.has('call:webhook')) problems.push('capabilities: a webhook plugin needs call:webhook');
  } else if (m.webhook) problems.push(`webhook: only for webhook plugins, not ${m.kind}`);
  if (m.kind === 'script' && !m.script) problems.push('script: a script plugin names its entry and source');
  if (m.kind !== 'script' && m.script) problems.push(`script: only for script plugins, not ${m.kind}`);
  if (m.kind === 'script' && m.actions?.length) problems.push('actions: a script plugin acts through its handler, not declarative actions');
  if (m.script) {
    const lang = m.script.language ?? 'javascript';
    if (!IDENTIFIER[lang].test(m.script.entry)) problems.push(`script.entry: ${m.script.entry} is not a function name in ${lang}`);
    const mods = blockedModules(lang, m.script.source);
    if (mods.length) problems.push(`script.source: line ${mods[0]!.line} uses ${mods[0]!.module}; handlers have no network and cannot start processes (platform calls go through the broker)`);
    const secrets = scanSecrets(m.script.source);
    if (secrets.length) problems.push(`script.source: line ${secrets[0]!.line}: ${secrets[0]!.what}; never put credentials in a plugin`);
  }
  if (m.config) {
    try {
      ajv.compile(m.config.schema);
    } catch (err) {
      problems.push(`config.schema: not a JSON Schema (${(err as Error).message})`);
    }
  }
  if (problems.length) throw new ManifestError(problems);
  return m;
}

/** Checks an install's configuration against the manifest's schema; returns the problems. */
export function configProblems(m: Manifest, config: Record<string, unknown> | undefined): string[] {
  if (!m.config) return config && Object.keys(config).length ? ['config: this plugin takes no configuration'] : [];
  const v = ajv.compile(m.config.schema);
  return v(config ?? {}) ? [] : (v.errors ?? []).map((e) => `config${e.instancePath} ${e.message ?? 'is invalid'}`);
}

/** The grants an install starts with when none are named: every low-risk capability asked for. */
export const defaultGrants = (m: Manifest): string[] => m.capabilities.filter((c) => capability(c)?.risk === 'low');

/** Capabilities the plugin cannot do without that are not granted. */
export const missingGrants = (m: Manifest, granted: readonly string[]): string[] => m.capabilities.filter((c) => !m.optionalCapabilities.includes(c) && !granted.includes(c));
