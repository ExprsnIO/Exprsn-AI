#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { loadConfig } from './config/index.js';
import { createDb, migrate } from './db/knex.js';
import { createLogger } from './observability/index.js';
import { createServices, type Services } from './services.js';
import { bootstrap } from './bootstrap.js';
import { checkPasswordPolicy, hashPassword } from './identity/passwords.js';
import { LABELS, type Label } from './authz/labels.js';
import { isRole } from './authz/permissions.js';

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
    The password is read from EXPRSN_ADMIN_PASSWORD or prompted for. Admin roles must enrol a second factor
    at first sign-in.
  audit:verify [--tenant slug] Recompute the audit hash chain and check its signed checkpoints
  kms:rotate [--tenant slug]   Start a new version of the tenant's data key (old values stay readable)
  backup:create                Back up the application database into the blob store (sealed, KMS-signed)
  backup:restore-drill [--backup id]
                               Restore a backup (default: the newest) into a scratch SQLite database and verify
                               its signature, digest, row counts and audit chains; the live database is not touched
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
      clearance: { type: 'string' }
    }
  });
  const username = values.username?.trim().toLowerCase();
  const displayName = values['display-name']?.trim();
  if (!username || !displayName) throw new Error('--username and --display-name are required');
  const roles = values.role?.length ? values.role : ['system-admin'];
  for (const r of roles) if (!isRole(r)) throw new Error(`Unknown role ${r}`);
  const clearance = (values.clearance ?? 'restricted') as Label;
  if (!(LABELS as readonly string[]).includes(clearance)) throw new Error(`Unknown clearance ${clearance}`);

  const tenant = await s.tenants.bySlug(values.tenant ?? s.cfg.DEFAULT_TENANT);
  if (!tenant) throw new Error('Unknown tenant');
  const local = (await s.providers.list(tenant.id)).find((p) => p.kind === 'local');
  if (!local) throw new Error('Tenant has no local user store');
  if (await s.users.byUsername(tenant.id, username)) throw new Error('A user with that username exists');

  const password = await readPassword(`Password for ${username}: `);
  const policy = checkPasswordPolicy(password, username);
  if (!policy.ok) throw new Error(policy.reason);

  const passwordHash = await hashPassword(password);
  const user = await s.db.transaction(async (trx) => {
    const users = s.users.within(trx);
    const u = await users.create(tenant.id, { username, displayName, email: values.email ?? null, clearance, mfaRequired: true });
    await users.update(tenant.id, u.id, { clearance_direct: clearance });
    await trx('local_credentials').insert({ user_id: u.id, password_hash: passwordHash, updated_at: Date.now() });
    await users.upsertIdentity(u.id, local.id, u.id, []);
    await users.setRoles(u.id, 'direct', roles);
    return u;
  });
  await s.audit.append({ tenantId: tenant.id, action: 'user.created', kind: 'admin', actor: { service: 'cli' }, target: { user: user.id, username }, detail: { roles, clearance, store: local.name } });
  process.stdout.write(`Created ${username} in tenant ${tenant.slug} with ${roles.join(', ')}. A second factor is required at first sign-in.\n`);
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
