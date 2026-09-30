#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { loadConfig } from './config/index.js';
import { createDb, migrate } from './db/knex.js';
import { createLogger } from './observability/index.js';
import { createServices, type Services } from './services.js';
import { bootstrap } from './bootstrap.js';
import { createAdmin } from './identity/admin-create.js';
import { createKms } from './platform/kms.js';
import { FsBlobStore } from './platform/blob.js';
import { createPreviousKms, rewrapAll } from './platform/rewrap.js';

const RESTORE_PHRASE = 'replace all data';

const USAGE = `exprsn-ai <command>

Commands:
  migrate                      Apply database migrations
  admin:create                 Create a local account (bootstrap administrator or break-glass)
      --username <name>        required
      --display-name <name>    required
      --email <address>
      --tenant <slug>          defaults to DEFAULT_TENANT
      --role <id>              repeatable; defaults to system-admin
      --clearance <label>      defaults to restricted
      --enrol-link             no password: print a single-use enrolment link instead (valid for
                               PASSWORD_INVITE_HOURS). Opening it sets the password and enrols the second factor in
                               one step, so the account is never usable with a password alone
    Without --enrol-link the password is read from EXPRSN_ADMIN_PASSWORD or prompted for. Admin roles must enrol a
    second factor at first sign-in.
  audit:verify [--tenant slug] Recompute the audit hash chain and check its signed checkpoints
  kms:rotate [--tenant slug]   Start a new version of the tenant's data key (old values stay readable)
  kms:rewrap                   Re-wrap every data key (and re-sign checkpoints and backup manifests) from the
                               previous key-encryption key to the current one, then verify. Set the new DATA_KEY (or
                               KMS_PROVIDER) and the old one as DATA_KEY_PREVIOUS (or KMS_PREVIOUS_PROVIDER). Safe to
                               repeat; once it reports verified, the previous key can be removed.
  backup:create                Back up the application database into the blob store (sealed, KMS-signed)
  backup:restore-drill [--backup id]
                               Restore a backup (default: the newest) into a scratch SQLite database and verify
                               its signature, digest, row counts and audit chains; the live database is not touched
  backup:restore --backup <id> Restore a backup into the configured database (and its blob store into the configured
      [--from <dir>]           blob store). Refuses a database that has tenants, users or audit events unless
      [--no-blobs]             --force is given with --confirm "${RESTORE_PHRASE}" (or the phrase is typed at the
      [--force]                prompt). --from reads the backup from a directory holding a copy of the blob store
      [--confirm <phrase>]     (platform/backups/...) instead of the configured store. Stop every instance first.
`;

async function readPassword(prompt: string): Promise<string> {
  if (process.env.EXPRSN_ADMIN_PASSWORD) return process.env.EXPRSN_ADMIN_PASSWORD;
  if (!process.stdin.isTTY) throw new Error('No TTY: set EXPRSN_ADMIN_PASSWORD');
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
  let muted = false;
  out._writeToOutput = (s: string) => {
    if (!muted) out.output.write(s);
  };
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

async function adminCreate(s: Services, argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      username: { type: 'string' },
      'display-name': { type: 'string' },
      email: { type: 'string' },
      tenant: { type: 'string' },
      role: { type: 'string', multiple: true },
      clearance: { type: 'string' },
      'enrol-link': { type: 'boolean' }
    }
  });
  const username = values.username?.trim().toLowerCase();
  if (!username || !values['display-name']?.trim()) throw new Error('--username and --display-name are required');
  // With an enrolment link nobody knows the password until the link sets it (B-810).
  const password = values['enrol-link'] ? null : await readPassword(`Password for ${username}: `);
  const out = await createAdmin(s, { username, displayName: values['display-name'], email: values.email ?? null, ...(values.tenant ? { tenant: values.tenant } : {}), ...(values.role ? { roles: values.role } : {}), ...(values.clearance ? { clearance: values.clearance } : {}), password });
  if (!out.enrol) {
    process.stdout.write(`Created ${username} in tenant ${out.tenantSlug} with ${out.roles.join(', ')}. A second factor is required at first sign-in.\n`);
    return;
  }
  process.stdout.write(`Created ${username} in tenant ${out.tenantSlug} with ${out.roles.join(', ')}. The account has no usable password yet.\n`);
  process.stdout.write(`Give this single-use enrolment link to ${username} over a trusted channel. It works once, for ${out.enrol.hours} hours, and sets the password and the second factor together:\n\n  ${out.enrol.link}\n\n`);
}

async function readLine(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) return '';
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => rl.question(prompt, (a) => {
    rl.close();
    resolve(a);
  }));
}

async function restore(s: Services, argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { backup: { type: 'string' }, from: { type: 'string' }, 'no-blobs': { type: 'boolean' }, force: { type: 'boolean' }, confirm: { type: 'string' } } });
  if (!values.backup || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(values.backup)) throw new Error('--backup <id> is required (the backup id, a ULID).');
  if (values.force) {
    const phrase = values.confirm ?? (await readLine(`This replaces every row in the database. Type "${RESTORE_PHRASE}" to continue: `));
    if (phrase.trim() !== RESTORE_PHRASE) throw new Error(`Not confirmed: --force needs --confirm "${RESTORE_PHRASE}".`);
  }
  const from = values.from ? new FsBlobStore(values.from) : s.blobs;
  const r = await s.ops.backups.restoreInto({ target: s.db, client: s.cfg.DB_CLIENT, kms: s.kms, from, blobsTo: values['no-blobs'] ? null : s.blobs, backupId: values.backup, force: !!values.force, progress: (m) => void process.stderr.write(`${m}\n`) });
  const tenant = await s.tenants.bySlug(s.cfg.DEFAULT_TENANT);
  if (tenant) await s.audit.append({ tenantId: tenant.id, action: 'platform.backup.restored', kind: 'system', actor: { service: 'cli' }, target: { backup: values.backup }, detail: { rows: r.rows, tables: r.tables, skipped: r.skipped, blobs: r.blobs, replaced: r.wiped, store: values.from ? 'directory' : s.blobs.kind } });
  process.stdout.write(`Restored backup ${values.backup}: ${r.rows} rows in ${r.tables} tables${r.blobs ? `, ${r.blobs.objects} blob store objects` : ''}.${r.skipped.length ? ` Not in this schema: ${r.skipped.join(', ')}.` : ''}\n`);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === '--help' || cmd === '-h') {
    process.stdout.write(USAGE);
    return;
  }
  const cfg = loadConfig();
  const log = createLogger(cfg.LOG_LEVEL === 'info' ? 'warn' : cfg.LOG_LEVEL, false);
  const db = createDb(cfg);
  let s: Services | undefined;
  try {
    const applied = await migrate(db);
    if (cmd === 'migrate') {
      process.stdout.write(applied.length ? `Applied: ${applied.join(', ')}\n` : 'Already up to date\n');
      return;
    }
    s = createServices(cfg, db, log);
    // A restore runs before the first-start seeding, so a fresh database stays empty until the backup fills it.
    if (cmd === 'backup:restore') {
      await restore(s, rest);
      return;
    }
    await bootstrap(s);
    switch (cmd) {
      case 'admin:create':
        await adminCreate(s, rest);
        break;
      case 'audit:verify': {
        const { values } = parseArgs({ args: rest, options: { tenant: { type: 'string' } } });
        const tenant = await s.tenants.bySlug(values.tenant ?? cfg.DEFAULT_TENANT);
        if (!tenant) throw new Error('Unknown tenant');
        const r = await s.checkpoints.verify(tenant.id);
        process.stdout.write(JSON.stringify(r, null, 2) + '\n');
        if (r.status !== 'verified') process.exitCode = 2;
        break;
      }
      case 'kms:rotate': {
        const { values } = parseArgs({ args: rest, options: { tenant: { type: 'string' } } });
        const tenant = await s.tenants.bySlug(values.tenant ?? cfg.DEFAULT_TENANT);
        if (!tenant) throw new Error('Unknown tenant');
        const r = await s.keys.rotate(tenant.id);
        await s.audit.append({ tenantId: tenant.id, action: 'kms.key.rotated', kind: 'system', actor: { service: 'cli' }, target: { key: s.keys.kekName(tenant.id) }, detail: r });
        process.stdout.write(`Data key for ${tenant.slug} rotated to version ${r.version}\n`);
        break;
      }
      case 'kms:rewrap': {
        const previous = createPreviousKms(cfg);
        if (!previous) throw new Error('No previous key-encryption key is configured: set DATA_KEY_PREVIOUS (or KMS_PREVIOUS_PROVIDER).');
        const target = createKms(cfg);
        const r = await rewrapAll({ db, blobs: s.blobs, target, previous, kekName: (scope) => s!.keys.kekName(scope), progress: (m) => void process.stderr.write(`${m}\n`) });
        const tenant = await s.tenants.bySlug(cfg.DEFAULT_TENANT);
        if (tenant) await s.audit.append({ tenantId: tenant.id, action: 'kms.rewrapped', kind: 'system', actor: { service: 'cli' }, target: { kms: target.kind }, detail: { previous: previous.kind, dataKeys: { ...r.dataKeys, failed: r.dataKeys.failed.length }, checkpoints: { ...r.checkpoints, failed: r.checkpoints.failed.length }, backups: { ...r.backups, failed: r.backups.failed.length }, verified: r.verified } });
        process.stdout.write(JSON.stringify(r, null, 2) + '\n');
        process.stdout.write(r.verified ? 'Every data key opens with the new key-encryption key. The previous key can be removed.\n' : 'Not finished: fix the failures above and run kms:rewrap again. Keep the previous key until it reports verified.\n');
        if (!r.verified) process.exitCode = 2;
        break;
      }
      case 'backup:create': {
        const tenant = await s.tenants.bySlug(cfg.DEFAULT_TENANT);
        if (!tenant) throw new Error('Unknown tenant');
        const b = await s.ops.backups.createNow({ tenantId: tenant.id, actor: { service: 'cli' }, userId: null }, async (pct, msg) => void process.stderr.write(`${pct}% ${msg}\n`));
        process.stdout.write(`Backup ${b.id}: ${b.tables} tables, ${b.rows} rows, ${b.bytes} bytes in the ${s.blobs.kind} blob store; manifest ${b.manifest_hash}\n`);
        break;
      }
      case 'backup:restore-drill': {
        const { values } = parseArgs({ args: rest, options: { backup: { type: 'string' } } });
        const tenant = await s.tenants.bySlug(cfg.DEFAULT_TENANT);
        if (!tenant) throw new Error('Unknown tenant');
        const d = await s.ops.backups.drillNow({ tenantId: tenant.id, actor: { service: 'cli' }, userId: null }, values.backup ?? null, async (pct, msg) => void process.stderr.write(`${pct}% ${msg}\n`));
        process.stdout.write(JSON.stringify({ drill: d.id, backup: d.backup_id, state: d.state, rpoMs: d.rpo_ms, rtoMs: d.rto_ms, withinTarget: d.within_target, steps: d.steps, detail: d.detail, error: d.error }, null, 2) + '\n');
        if (d.state !== 'passed') process.exitCode = 2;
        break;
      }
      default:
        process.stdout.write(USAGE);
        process.exitCode = 64;
    }
  } finally {
    await s?.close();
    await db.destroy();
  }
}

main().catch((err: Error) => {
  process.stderr.write(`error: ${err.message}\n`);
  process.exit(1);
});
