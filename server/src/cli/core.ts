import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { LABELS, type Label } from '../authz/labels.js';
import { HttpProblem } from '../http/problem.js';
import { parseYamlSafely } from '../platform/yaml.js';
import { CAPABILITIES } from '../plugins/capabilities.js';
import { manifestView, pluginView, type PluginActor } from '../plugins/service.js';
import { isEventPattern } from '../webhooks/service.js';
import type { Services } from '../services.js';

/*
 * Sprint 24c (B-2103): the `plugins` and `events replay` commands of the `exprsn-ai` CLI. They act as the operator
 * (`{ service: 'cli' }` in the audit chain, cleared for every label) on the tenant named by `--tenant` (default
 * DEFAULT_TENANT), through the same services as the API, so the same checks and audit entries apply. Each command
 * writes to `out` and returns its exit code, so the tests run it against a test database.
 */

export type Out = (text: string) => void;

export const PLUGINS_USAGE = `exprsn-ai plugins <command> [--tenant <slug>]

  list [--removed] [--json]          Installed plugins with their state and grants
  show <key>                         One plugin: manifest, grants and lifecycle history
  capabilities                       The capability vocabulary a manifest may ask for
  validate --manifest <file>         Check a manifest (JSON or YAML) without installing it
  install --manifest <file>          Install (or reinstall a removed) plugin. Grants default to the low-risk
      [--grant <capability>]...      capabilities the manifest asks for; name high-risk ones to grant them.
      [--max-label <label>]          Highest label of the events it may receive (default internal)
      [--config <file>]              Configuration (JSON or YAML), checked against the manifest's schema
      [--reason <text>]
  enable <key> [--reason <text>]     installed or disabled -> enabled (every required capability granted)
  disable <key> [--reason <text>]    installed or enabled -> disabled
  remove <key> [--reason <text>]     -> removed (it can be installed again)
  grants <key> --grant <capability>... | --none [--reason <text>]
                                     Replace the grants; an enabled plugin losing a required one is disabled
`;

export const EVENTS_USAGE = `exprsn-ai events replay --webhook <id> [--tenant <slug>]
      [--source deliveries|audit]    deliveries (default): send past deliveries again, each its exact body.
                                     audit: backfill audit-action events from the audit chain that the webhook
                                     never received (within its event list and label)
      [--since <time>] [--until <time>]
                                     ISO 8601 times or durations back from now (30m, 6h, 7d)
      [--type <pattern>]...          Only these events (a name, a prefix ending in .* or *)
      [--state pending|succeeded|failed]
                                     deliveries only
      [--limit <n>]                  At most n events (default 1000, at most 10000)
      [--dry-run]                    Report what would be sent; send nothing
`;

const operator: PluginActor = { userId: null, clearance: 'restricted', audit: { service: 'cli' } };

function readDoc(file: string): unknown {
  const text = readFileSync(file, 'utf8');
  if (/^\s*[[{]/.test(text)) return JSON.parse(text) as unknown;
  return parseYamlSafely(text);
}

/** An ISO time or a duration back from now (`30m`, `6h`, `7d`). */
export function parseTime(v: string | undefined, now = Date.now()): number | undefined {
  if (v == null) return undefined;
  const d = /^(\d+)([smhd])$/.exec(v.trim());
  if (d) return now - Number(d[1]) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[d[2] as 's' | 'm' | 'h' | 'd'];
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new Error(`Not a time: ${v} (an ISO 8601 time, or 30m, 6h, 7d)`);
  return t;
}

async function tenantId(s: Services, slug: string | undefined): Promise<string> {
  const t = await s.tenants.bySlug(slug ?? s.cfg.DEFAULT_TENANT);
  if (!t) throw new Error(`Unknown tenant ${slug ?? s.cfg.DEFAULT_TENANT}`);
  return t.id;
}

const problemText = (err: unknown): string => {
  if (err instanceof HttpProblem) {
    const errors = (err.extensions?.errors as (string | { path: string; message: string })[] | undefined) ?? [];
    const lines = errors.map((e) => (typeof e === 'string' ? e : `${e.path}: ${e.message}`));
    return [err.detail ?? err.title, ...lines.filter((l) => l !== err.detail).map((l) => `  ${l}`)].join('\n');
  }
  return (err as Error).message;
};

const line = (p: ReturnType<typeof pluginView>) => `${p.key.padEnd(24)} ${p.version.padEnd(10)} ${p.state.padEnd(10)} ${p.kind.padEnd(12)} granted: ${p.granted.join(', ') || '(none)'}${p.missing.length ? `  missing: ${p.missing.join(', ')}` : ''}`;

export async function pluginsCommand(s: Services, argv: string[], out: Out): Promise<number> {
  const [sub, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { tenant: { type: 'string' }, removed: { type: 'boolean' }, json: { type: 'boolean' }, manifest: { type: 'string' }, grant: { type: 'string', multiple: true }, none: { type: 'boolean' }, 'max-label': { type: 'string' }, config: { type: 'string' }, reason: { type: 'string' } }
  });
  const key = positionals[0];
  try {
    switch (sub) {
      case 'capabilities':
        for (const c of CAPABILITIES) out(`${c.name.padEnd(20)} ${c.risk.padEnd(5)} ${c.description}\n`);
        return 0;
      case 'validate': {
        if (!values.manifest) throw new Error('--manifest <file> is required');
        const m = s.plugins.check(readDoc(values.manifest));
        out(`Valid: ${m.key} ${m.version} (${m.kind}), capabilities ${m.capabilities.join(', ') || 'none'}.\n`);
        return 0;
      }
      case 'list': {
        const t = await tenantId(s, values.tenant);
        const rows = (await s.plugins.list(t, operator.clearance, { removed: !!values.removed })).map(pluginView);
        if (values.json) out(JSON.stringify(rows, null, 2) + '\n');
        else if (!rows.length) out('No plugins installed.\n');
        else for (const p of rows) out(line(p) + '\n');
        return 0;
      }
      case 'show': {
        if (!key) throw new Error('Name the plugin: plugins show <key>');
        const t = await tenantId(s, values.tenant);
        const p = await s.plugins.get(t, key, operator.clearance);
        out(JSON.stringify({ ...pluginView(p), manifest: manifestView(p.manifest), transitions: await s.plugins.transitions(t, p.id) }, null, 2) + '\n');
        return 0;
      }
      case 'install': {
        if (!values.manifest) throw new Error('--manifest <file> is required');
        const maxLabel = (values['max-label'] ?? 'internal') as Label;
        if (!(LABELS as readonly string[]).includes(maxLabel)) throw new Error(`--max-label is one of ${LABELS.join(', ')}`);
        const t = await tenantId(s, values.tenant);
        const p = await s.plugins.install(t, operator, { manifest: readDoc(values.manifest), maxLabel, ...(values.grant ? { grants: values.grant } : values.none ? { grants: [] } : {}), ...(values.config ? { config: readDoc(values.config) as Record<string, unknown> } : {}), reason: values.reason ?? null });
        out(`Installed ${line(pluginView(p))}\n`);
        return 0;
      }
      case 'enable':
      case 'disable':
      case 'remove': {
        if (!key) throw new Error(`Name the plugin: plugins ${sub} <key>`);
        const t = await tenantId(s, values.tenant);
        const p = await s.plugins.transition(t, operator, key, sub, values.reason ?? null);
        out(`${p.plugin_key} is ${p.state}.\n`);
        return 0;
      }
      case 'grants': {
        if (!key) throw new Error('Name the plugin: plugins grants <key> --grant <capability>...');
        if (!values.grant && !values.none) throw new Error('Name the grants with --grant (repeatable), or --none to withdraw them all');
        const t = await tenantId(s, values.tenant);
        const p = await s.plugins.setGrants(t, operator, key, values.grant ?? [], values.reason ?? null);
        out(`${line(pluginView(p))}\n`);
        return 0;
      }
      default:
        out(PLUGINS_USAGE);
        return sub ? 64 : 0;
    }
  } catch (err) {
    out(`error: ${problemText(err)}\n`);
    return err instanceof HttpProblem && err.status === 409 ? 3 : 1;
  }
}

export async function eventsCommand(s: Services, argv: string[], out: Out): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub !== 'replay') {
    out(EVENTS_USAGE);
    return sub ? 64 : 0;
  }
  try {
    const { values } = parseArgs({ args: rest, options: { tenant: { type: 'string' }, webhook: { type: 'string' }, source: { type: 'string' }, since: { type: 'string' }, until: { type: 'string' }, type: { type: 'string', multiple: true }, state: { type: 'string' }, limit: { type: 'string' }, 'dry-run': { type: 'boolean' } } });
    if (!values.webhook) throw new Error('--webhook <id> is required');
    const source = values.source ?? 'deliveries';
    if (source !== 'deliveries' && source !== 'audit') throw new Error('--source is deliveries or audit');
    for (const t of values.type ?? []) if (!isEventPattern(t)) throw new Error(`--type ${t}: a name, a prefix ending in .* or *`);
    if (values.state && !['pending', 'succeeded', 'failed'].includes(values.state)) throw new Error('--state is pending, succeeded or failed');
    if (values.state && source === 'audit') throw new Error('--state applies to --source deliveries');
    const limit = values.limit ? Number(values.limit) : undefined;
    if (limit != null && (!Number.isInteger(limit) || limit < 1 || limit > 10_000)) throw new Error('--limit is 1 to 10000');
    const since = parseTime(values.since);
    const until = parseTime(values.until);
    const t = await tenantId(s, values.tenant);
    const filter = { ...(since != null ? { since } : {}), ...(until != null ? { until } : {}), ...(values.type ? { types: values.type } : {}), ...(values.state ? { state: values.state as 'pending' | 'succeeded' | 'failed' } : {}), ...(limit ? { limit } : {}), dryRun: !!values['dry-run'] };
    const w = await s.webhooks.get(t, values.webhook);
    if (source === 'deliveries') {
      const r = await s.webhooks.replayDeliveries(t, w.id, filter);
      if (!filter.dryRun) await s.audit.append({ tenantId: t, action: 'webhook.replayed', kind: 'admin', actor: { service: 'cli' }, target: { webhook: w.id, name: w.name }, detail: { source, matched: r.matched, queued: r.queued, since: since ?? null, until: until ?? null, types: values.type ?? null, state: values.state ?? null } });
      out(filter.dryRun ? `Would replay ${r.matched} deliveries to ${w.name}.\n` : `Replayed ${r.queued} of ${r.matched} deliveries to ${w.name}; they are queued as new deliveries.\n`);
    } else {
      const r = await s.webhooks.backfillAudit(t, w.id, filter);
      if (!filter.dryRun) await s.audit.append({ tenantId: t, action: 'webhook.replayed', kind: 'admin', actor: { service: 'cli' }, target: { webhook: w.id, name: w.name }, detail: { source, matched: r.matched, queued: r.queued, skipped: r.skipped, since: since ?? null, until: until ?? null, types: values.type ?? null } });
      out(filter.dryRun ? `Would send ${r.matched} audit events to ${w.name}.\n` : `Queued ${r.queued} audit events to ${w.name}; ${r.skipped} it already had were skipped.\n`);
    }
    return 0;
  } catch (err) {
    out(`error: ${problemText(err)}\n`);
    return 1;
  }
}
