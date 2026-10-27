import { parseArgs } from 'node:util';
import { PkiError, type PkiActor } from '../pki/service.js';
import { PKI_SETTING_KEYS } from '../pki/settings.js';
import type { Services } from '../services.js';
import type { Out } from './pki.js';

/*
 * 1.9.0, Sprint 55 (B-195): `exprsn-ai pki:settings`, the certificate authority's settings from the shell, through
 * the same service as Certificates › Settings (ranges, floors and audit alike; `{ service: 'cli' }` in the chain).
 * The operator acts as a platform administrator for the platform scope, but cannot approve: a change to the root or
 * the intermediates made here waits for a platform admin to approve it in the console (dual control).
 * Exit codes: 0 done, 1 refused or failed, 3 conflict, 64 usage.
 */

export const PKI_SETTINGS_USAGE = `exprsn-ai pki:settings <command>

  show [--tenant <slug>] [--platform] [--json]
                                     Every setting with its effective value and where it comes from (tenant,
                                     platform, environment or default), its floor and its range
  set <key>=<value>... [--tenant <slug> | --platform] [--reason <text>]
                                     Save values (JSON where it parses: 30, true, null, {"O":"Example"}; else text).
                                     Root and intermediate settings become a proposal for a platform admin
  reset <key>... [--tenant <slug> | --platform]
                                     Back to inheriting (a tenant from the platform, the platform from the environment)
  proposals [--json]                 Changes waiting for a second platform admin

Keys: ${PKI_SETTING_KEYS.join(', ')}
`;

const show = (v: unknown) => (v === null || v === undefined ? 'none' : typeof v === 'object' ? JSON.stringify(v) : String(v));

function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

export async function pkiSettingsCommand(s: Services, argv: string[], out: Out): Promise<number> {
  const [sub, ...rest] = argv;
  try {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { tenant: { type: 'string' }, platform: { type: 'boolean' }, json: { type: 'boolean' }, reason: { type: 'string' } } });
    const slug = values.tenant ?? s.cfg.DEFAULT_TENANT;
    const tenant = await s.tenants.bySlug(slug);
    if (!tenant) throw new Error(`Unknown tenant ${slug}`);
    const by: PkiActor = { tenantId: tenant.id, userId: null, actor: { service: 'cli' } };
    const scope: 'platform' | 'tenant' = values.platform ? 'platform' : values.tenant ? 'tenant' : 'platform';
    switch (sub ?? 'show') {
      case 'show': {
        const rows = await s.pkiSettings.describe(tenant.id, values.platform || !values.tenant ? 'platform' : 'tenant');
        if (values.json) {
          out(JSON.stringify({ configured: await s.pkiSettings.configured(), scope: values.platform || !values.tenant ? 'platform' : tenant.slug, settings: rows }, null, 2) + '\n');
          return 0;
        }
        if (!(await s.pkiSettings.configured())) out('Saved settings are not available yet (migration 127_pki_settings has not run); these are the environment values.\n');
        for (const r of rows) out(`${r.key.padEnd(26)} ${show(r.value).padEnd(28)} ${r.source.padEnd(11)}${r.floor ? ` floor ${show(r.floor.value)} (${r.floor.source})` : ''}${r.dual ? '  [dual control]' : ''}\n`);
        return 0;
      }
      case 'set': {
        if (!positionals.length) throw new Error('Name at least one key=value.');
        const vals: Record<string, unknown> = {};
        for (const p of positionals) {
          const i = p.indexOf('=');
          if (i < 1) throw new Error(`${p}: write key=value.`);
          vals[p.slice(0, i)] = parseValue(p.slice(i + 1));
        }
        const r = await s.pkiSettings.save(by, scope, { values: vals, reason: values.reason ?? null }, true);
        if (r.applied.length) out(`Saved: ${r.applied.join(', ')}.\n`);
        if (r.proposal) out(`Proposed ${r.proposal.id} (${Object.keys(r.proposal.changes).join(', ')}): a platform admin approves it under Certificates › Settings; it applies at the next rotation or re-issue.\n`);
        if (!r.applied.length && !r.proposal) out('Nothing changed.\n');
        return 0;
      }
      case 'reset': {
        if (!positionals.length) throw new Error('Name at least one key.');
        const r = await s.pkiSettings.save(by, scope, { reset: positionals, reason: values.reason ?? null }, true);
        out(r.applied.length || r.proposal ? `Reset: ${[...r.applied, ...Object.keys(r.proposal?.changes ?? {})].join(', ')}${r.proposal ? ` (proposal ${r.proposal.id} for the root and intermediates)` : ''}.\n` : 'Nothing changed.\n');
        return 0;
      }
      case 'proposals': {
        const rows = await s.pkiSettings.proposals('pending');
        if (values.json) out(JSON.stringify(rows, null, 2) + '\n');
        else if (!rows.length) out('No proposals wait.\n');
        else for (const p of rows) out(`${p.id}  ${new Date(p.proposed_at).toISOString().slice(0, 16)}  ${p.proposed_by ?? 'cli'}  ${Object.entries(p.changes).map(([k, v]) => `${k}=${show(v)}`).join(' ')}\n`);
        return 0;
      }
      default:
        out(PKI_SETTINGS_USAGE);
        return 64;
    }
  } catch (err) {
    out(`error: ${(err as Error).message}\n`);
    return err instanceof PkiError && err.status === 409 ? 3 : 1;
  }
}
