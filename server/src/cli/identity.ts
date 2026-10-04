import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { isLabel, type Label } from '../authz/labels.js';
import { permissionsFor, type Permission } from '../authz/permissions.js';
import { HttpProblem } from '../http/problem.js';
import { CAPABILITIES, type Capability, type Subjects } from '../vault/policy.js';
import type { VaultCaller } from '../vault/service.js';
import type { Services } from '../services.js';
import type { RowResult } from '../identity/user-import.js';

/*
 * Sprint 26a (B-2103): `exprsn-ai secrets` and `exprsn-ai users import`.
 *
 * `secrets` works through the vault service, so the same path policies, clearance checks and audit entries apply: the
 * command runs on behalf of an account (`--as <username>`), whose roles, policy subjects and clearance decide, and is
 * audited as the CLI acting for that account (`{ service: 'cli', user, via: 'cli' }`). Values never go to the audit
 * chain or the log, only to standard output.
 *
 * `users import` runs the same import as `POST /api/admin/user-imports`, in this process, as the operator (no role
 * ceiling, as for `admin:create`); `--dry-run` prints the plan and writes nothing.
 *
 * Each command writes to `out` and returns its exit code, so the tests run it against a test database. Exit codes:
 * 0 done, 1 refused or failed, 3 conflicts in an import, 64 usage.
 */

export type Out = (text: string) => void;

export const SECRETS_USAGE = `exprsn-ai secrets <command> --as <username> [--tenant <slug>]

  kv list [<prefix>] [--json]           Secrets the account may list (metadata only)
  kv get <path> [--version <n>]         A version's data (default: the current one) as JSON, or one field
      [--field <key>]
  kv put <path> <key>=<value>...        Writes a new version; <key>=@<file> reads the value from a file
      [--cas <n>] [--label <label>]
  transit encrypt <key> --plaintext <text> | --base64 <data> [--context <base64>]
  transit decrypt <key> <ciphertext> [--context <base64>] [--base64]
                                        Prints the plaintext (as text, or base64 with --base64)
  policy explain <path> --capability <cap> [--group <name> | --workspace <id>]
                                        The decision for the account (or a group or workspace alone) and the
                                        grant that decides it. Capabilities: ${CAPABILITIES.join(', ')}
`;

export const USERS_USAGE = `exprsn-ai users import <file.csv> [--dry-run] [--send-invites] [--tenant <slug>] [--json]

  Users, workspace memberships and group mappings from one CSV (header:
  kind,username,display_name,email,roles,clearance,workspace,provider,group). --dry-run prints the plan and changes
  nothing; --send-invites emails new accounts a link to set their password (needs SMTP).
`;

async function tenantOf(s: Services, slug: string | undefined) {
  const t = await s.tenants.bySlug(slug ?? s.cfg.DEFAULT_TENANT);
  if (!t) throw new Error(`Unknown tenant ${slug ?? s.cfg.DEFAULT_TENANT}`);
  return t;
}

/** The vault caller for `--as`: an active account holding `need`, audited as the CLI acting for it. */
async function callerAs(s: Services, tenantId: string, username: string | undefined, need: Permission): Promise<VaultCaller> {
  if (!username) throw new Error('--as <username> is required: the command runs under that account\'s vault policy');
  const user = await s.users.byUsername(tenantId, username);
  if (!user || user.state !== 'active') throw new Error(`No active account ${username} in this tenant`);
  if (!permissionsFor(await s.users.roleIds(user.id)).has(need)) throw new HttpProblem(403, 'Forbidden', `${user.username} does not hold ${need}.`);
  return {
    tenantId,
    clearance: (isLabel(user.clearance) ? user.clearance : 'public') as Label,
    subjects: await s.vault.subjectsFor(tenantId, user.id, null),
    actor: { service: 'cli', user: user.id, username: user.username, via: 'cli' },
    traceId: null,
    denialKey: `${tenantId}:cli:${user.id}`
  };
}

const fail = (out: Out, err: unknown): number => {
  const e = err as Error & { detail?: string; status?: number };
  out(`error: ${e instanceof HttpProblem ? (e.detail ?? e.title) : e.message}\n`);
  return e instanceof HttpProblem && e.status === 409 ? 3 : 1;
};

export async function secretsCommand(s: Services, argv: string[], out: Out): Promise<number> {
  const [area, sub, ...rest] = argv;
  if (!area || !sub) {
    out(SECRETS_USAGE);
    return 64;
  }
  try {
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: { tenant: { type: 'string' }, as: { type: 'string' }, json: { type: 'boolean' }, version: { type: 'string' }, field: { type: 'string' }, cas: { type: 'string' }, label: { type: 'string' }, plaintext: { type: 'string' }, base64: { type: 'boolean' }, context: { type: 'string' }, capability: { type: 'string' }, group: { type: 'string' }, workspace: { type: 'string' } }
    });
    const t = await tenantOf(s, values.tenant);
    const ctx = (v: string | undefined) => (v ? Buffer.from(v, 'base64') : null);
    switch (`${area} ${sub}`) {
      case 'kv list': {
        const c = await callerAs(s, t.id, values.as, 'secrets:read');
        const rows = await s.vault.list(c, positionals[0]);
        if (values.json) out(JSON.stringify(rows, null, 2) + '\n');
        else if (!rows.length) out('No secrets.\n');
        else for (const r of rows) out(`${r.path}  v${r.currentVersion}  ${r.label}\n`);
        return 0;
      }
      case 'kv get': {
        const path = positionals[0];
        if (!path) throw new Error('Name the secret: secrets kv get <path>');
        const version = values.version ? Number(values.version) : undefined;
        if (version !== undefined && (!Number.isInteger(version) || version < 1)) throw new Error('--version is a whole number from 1');
        const c = await callerAs(s, t.id, values.as, 'secrets:read');
        const r = await s.vault.read(c, path, version);
        if (values.field) {
          if (!(values.field in r.data)) throw new Error(`Version ${r.version} of ${r.path} has no field ${values.field}`);
          out(`${r.data[values.field]}\n`);
        } else out(JSON.stringify(values.json ? { path: r.path, version: r.version, label: r.label, data: r.data } : r.data, null, 2) + '\n');
        return 0;
      }
      case 'kv put': {
        const [path, ...pairs] = positionals;
        if (!path || !pairs.length) throw new Error('secrets kv put <path> <key>=<value>...');
        const data: Record<string, string> = {};
        for (const pair of pairs) {
          const k = pair.indexOf('=');
          if (k < 1) throw new Error(`${pair}: use <key>=<value> or <key>=@<file>`);
          const key = pair.slice(0, k);
          const value = pair.slice(k + 1);
          data[key] = value.startsWith('@') ? readFileSync(value.slice(1), 'utf8') : value;
        }
        const cas = values.cas !== undefined ? Number(values.cas) : undefined;
        if (cas !== undefined && (!Number.isInteger(cas) || cas < 0)) throw new Error('--cas is a whole number from 0');
        if (values.label && !isLabel(values.label)) throw new Error(`Unknown label ${values.label}`);
        const c = await callerAs(s, t.id, values.as, 'secrets:write');
        const r = await s.vault.write(c, path, data, { ...(cas !== undefined ? { cas } : {}), ...(values.label ? { label: values.label as Label } : {}) });
        out(`Wrote ${r.path} version ${r.version}.\n`);
        return 0;
      }
      case 'transit encrypt': {
        const key = positionals[0];
        if (!key) throw new Error('Name the key: secrets transit encrypt <key>');
        if (values.plaintext === undefined) throw new Error('--plaintext <text> is required (with --base64 the text is base64)');
        const plaintext = values.base64 ? Buffer.from(values.plaintext, 'base64') : Buffer.from(values.plaintext, 'utf8');
        const c = await callerAs(s, t.id, values.as, 'secrets:read');
        const [ciphertext] = await s.vault.encrypt(c, key, [{ plaintext, context: ctx(values.context) }]);
        out(`${ciphertext}\n`);
        return 0;
      }
      case 'transit decrypt': {
        const [key, ciphertext] = positionals;
        if (!key || !ciphertext) throw new Error('secrets transit decrypt <key> <ciphertext>');
        const c = await callerAs(s, t.id, values.as, 'secrets:read');
        const [r] = await s.vault.decrypt(c, key, [{ ciphertext, context: ctx(values.context) }]);
        if (!r || 'error' in r) throw new HttpProblem(r?.status ?? 400, 'Refused', r && 'error' in r ? r.error : 'The ciphertext was refused.');
        out(`${values.base64 ? r.plaintext.toString('base64') : r.plaintext.toString('utf8')}\n`);
        return 0;
      }
      case 'policy explain': {
        const path = positionals[0];
        if (!path) throw new Error('secrets policy explain <path> --capability <cap>');
        if (!values.capability || !(CAPABILITIES as readonly string[]).includes(values.capability)) throw new Error(`--capability is one of ${CAPABILITIES.join(', ')}`);
        let subjects: Subjects;
        if (values.group || values.workspace) subjects = { userId: null, groups: values.group ? [values.group.trim().toLowerCase()] : [], workspaces: values.workspace ? [values.workspace] : [], apiKeyId: null };
        else {
          if (!values.as) throw new Error('--as <username>, --group <name> or --workspace <id> names whom to explain');
          const user = await s.users.byUsername(t.id, values.as);
          if (!user) throw new Error(`No account ${values.as} in this tenant`);
          subjects = await s.vault.subjectsFor(t.id, user.id, null);
        }
        const r = await s.vault.explain(t.id, subjects, path, values.capability as Capability);
        await s.audit.append({ tenantId: t.id, action: 'vault.policy.explained', kind: 'decision', actor: { service: 'cli' }, target: { path, capability: values.capability }, label: 'internal', detail: { allow: r.decision.allow, grant: r.decision.grant?.id ?? null } });
        out(JSON.stringify(r, null, 2) + '\n');
        return 0;
      }
      default:
        out(SECRETS_USAGE);
        return 64;
    }
  } catch (err) {
    return fail(out, err);
  }
}

const reportLine = (r: RowResult) => `row ${String(r.row).padStart(4)}  ${r.kind.padEnd(10)}  ${r.action.padEnd(9)}  ${r.key}: ${r.detail}${r.outcome ? ` [${r.outcome}]` : ''}`;

export async function usersCommand(s: Services, argv: string[], out: Out): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub !== 'import') {
    out(USERS_USAGE);
    return 64;
  }
  try {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { tenant: { type: 'string' }, 'dry-run': { type: 'boolean' }, 'send-invites': { type: 'boolean' }, json: { type: 'boolean' } } });
    const file = positionals[0];
    if (!file) {
      out(USERS_USAGE);
      return 64;
    }
    const csv = readFileSync(file, 'utf8');
    if (Buffer.byteLength(csv) > s.cfg.USER_IMPORT_MAX_BYTES) throw new Error(`The CSV is larger than USER_IMPORT_MAX_BYTES (${s.cfg.USER_IMPORT_MAX_BYTES})`);
    const t = await tenantOf(s, values.tenant);
    const dryRun = !!values['dry-run'];
    const r = await s.userImports.run({ kind: 'cli', tenantId: t.id }, csv, { dryRun, sendInvites: !!values['send-invites'] });
    await s.audit.append({ tenantId: t.id, action: dryRun ? 'user.import.dry_run_reported' : 'user.import.completed', kind: 'admin', actor: { service: 'cli' }, target: { file: file.slice(-200) }, detail: { ...r.summary } });
    if (values.json) out(JSON.stringify(r, null, 2) + '\n');
    else {
      for (const row of r.report) out(reportLine(row) + '\n');
      const sm = r.summary;
      out(`${dryRun ? 'Dry run, nothing changed: ' : ''}${sm.rows} rows: ${sm.create} to create, ${sm.update} to update, ${sm.unchanged} unchanged, ${sm.conflict} conflicts, ${sm.error} errors${dryRun ? '' : `; ${sm.applied} applied`}.\n`);
    }
    return r.summary.conflict || r.summary.error ? 3 : 0;
  } catch (err) {
    return fail(out, err);
  }
}
