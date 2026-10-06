#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { loadConfig } from './config/index.js';
import { createDb, migrate } from './db/knex.js';
import { createLogger } from './observability/index.js';
import { createServices, type Services } from './services.js';
import { bootstrap } from './bootstrap.js';
import { createAdmin } from './identity/admin-create.js';
import { provisionTenant, TEMPLATE_IDS, type TemplateId } from './tenancy/templates.js';
import { createKms } from './platform/kms.js';
import { FsBlobStore } from './platform/blob.js';
import { createPreviousKms, rewrapAll } from './platform/rewrap.js';
import { readPrivateFile, startSigner } from './signer/server.js';
import { writeFileSync } from 'node:fs';
import { migrateCheck, schemaStatus } from './db/schema.js';
import { decodeShare, escrowById, escrowKey, recordEscrow, recoverKey } from './platform/escrow.js';
import { eventsCommand, pluginsCommand } from './cli/core.js';
import { pkiCommand } from './cli/pki.js';
import { secretsCommand, usersCommand } from './cli/identity.js';

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
  tenant:create                1.6.0: create a tenant from a template (workspaces, custom roles, draft profiles, a zone,
      --template <id>          an issuing CA) with its first admin in one step. Templates: enterprise, team, personal
      --slug <slug>            required
      --name <name>            required
      --admin-username <name>  required: the first admin (tenant-admin, cleared for the highest workspace ceiling,
      --admin-display-name <n> a member of every workspace)
      [--admin-email <address>]
      [--password]             read the admin's password from EXPRSN_ADMIN_PASSWORD or a prompt; without it a
                               single-use enrolment link is printed (PASSWORD_INVITE_HOURS)
  audit:verify [--tenant slug] Recompute the audit hash chain and check its signed checkpoints
  kms:rotate [--tenant slug]   Start a new version of the tenant's data key (old values stay readable)
  kms:rewrap                   Re-wrap every data key (and re-sign checkpoints, backup manifests, image provenance and
                               training model cards) from the previous key-encryption key to the current one, then
                               verify. Set the new DATA_KEY (or
                               KMS_PROVIDER) and the old one as DATA_KEY_PREVIOUS (or KMS_PREVIOUS_PROVIDER). Safe to
                               repeat; once it reports verified, the previous key can be removed.
  signer                       Run the signer process (Sprint 20): holds the local key-encryption key and the OIDC,
      [--socket <path>]        SAML and webhook private keys, and answers the app on a UNIX socket. Reads
      [--key-file <path>]      SIGNER_SOCKET, SIGNER_KEY_FILE (the key-encryption key, base64; what DATA_KEY was),
      [--token-file <path>]    SIGNER_TOKEN_FILE (the token the app presents) and SIGNER_SOCKET_MODE (0600, or 0660
      [--socket-mode <mode>]   when the app runs as another user in the socket's group). Needs no other settings.
      [--allow-group-read]     The key and token files must be mode 0600; this (SIGNER_ALLOW_GROUP_READ=true) also
                               accepts group-readable files, for Kubernetes secret volumes mounted into the signer only.
                               Run it as its own user; the app then sets SIGNER_SOCKET and SIGNER_TOKEN_FILE and no
                               DATA_KEY.
  migrate --check              Sprint 22: list pending migrations and their destructive steps without applying anything.
                               Exit 0 up to date, 2 pending, 3 pending with destructive (contract) steps, 4 the
                               database is newer than this build
  kms:escrow --shares <n> --threshold <k> [--key-file <signer key file>]
                               Sprint 22: split the local key-encryption key (DATA_KEY) into n Shamir shares of which
                               any k rebuild it. Each share is printed once with its check value; the key check value
                               is recorded in the database. Hand each share to a different custodian
  kms:recover --out <file> [--share <text>]... [--check <value>]
                               Sprint 22: rebuild the key from k shares (as --share, or one per line on stdin), verify
                               it against the escrow's key check value (from the database, or --check as printed at
                               escrow time) and write it, base64, to a new file readable by the owner only (for
                               DATA_KEY_FILE). Works without a database when --check is given
  backup:create                Back up the application database into the blob store (sealed, KMS-signed)
  backup:restore-drill [--backup id]
                               Restore a backup (default: the newest) into a scratch SQLite database and verify
                               its signature, digest, row counts and audit chains; the live database is not touched
  backup:restore --backup <id> Restore a backup into the configured database (and its blob store into the configured
      [--from <dir>]           blob store). Refuses a database that has tenants, users or audit events unless
      [--no-blobs]             --force is given with --confirm "${RESTORE_PHRASE}" (or the phrase is typed at the
      [--force]                prompt). --from reads the backup from a directory holding a copy of the blob store
      [--confirm <phrase>]     (platform/backups/...) instead of the configured store. Stop every instance first.
  plugins <command>            1.4.0: list, show, capabilities, validate, install, enable, disable, remove and grants
                               for a tenant's plugins (\`exprsn-ai plugins\` lists the options)
  events replay --webhook <id> 1.4.0: send a webhook's past deliveries again, or backfill audit events it never
                               received (\`exprsn-ai events\` lists the options)
  pki <command>                1.4.0: issuers, list, issue, revoke and crl for a tenant's certificate authority
                               (\`exprsn-ai pki\` lists the options)
  secrets <command> --as <user> 1.4.0: kv list, get and put, transit encrypt and decrypt, policy explain, through the
                               vault under that account's policy, audited as the CLI (\`exprsn-ai secrets\` lists them)
  users import <file.csv>      1.4.0: users, memberships and group mappings from CSV; --dry-run prints the plan and
      [--dry-run]              changes nothing (\`exprsn-ai users\` lists the options)
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

async function tenantCreate(s: Services, argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      template: { type: 'string' },
      slug: { type: 'string' },
      name: { type: 'string' },
      'admin-username': { type: 'string' },
      'admin-display-name': { type: 'string' },
      'admin-email': { type: 'string' },
      password: { type: 'boolean' }
    }
  });
  const template = values.template as TemplateId | undefined;
  if (!template || !(TEMPLATE_IDS as readonly string[]).includes(template)) throw new Error(`--template is one of ${TEMPLATE_IDS.join(', ')}`);
  const slug = values.slug?.trim().toLowerCase();
  if (!slug || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) throw new Error('--slug is required: lower-case letters, digits and dashes');
  if (!values.name?.trim()) throw new Error('--name is required');
  const username = values['admin-username']?.trim().toLowerCase();
  if (!username || !values['admin-display-name']?.trim()) throw new Error('--admin-username and --admin-display-name are required');
  const password = values.password ? await readPassword(`Password for ${username}: `) : null;
  const out = await provisionTenant(s, { tenantId: null, userId: null, actor: { service: 'cli' } }, { template, slug, name: values.name.trim(), admin: { username, displayName: values['admin-display-name'].trim(), email: values['admin-email'] ?? null, password } });
  const a = out.applied;
  process.stdout.write(`Created tenant ${out.tenant.slug} (${out.tenant.name}) from the ${template} template.\n`);
  process.stdout.write(`  Workspaces: ${a.workspaces.map((w) => `${w.name} (${w.label})`).join(', ')}\n`);
  process.stdout.write(`  Custom roles: ${a.roles.length ? a.roles.map((r) => r.name).join(', ') : 'none'}\n`);
  process.stdout.write(`  Draft profiles: ${a.profiles.map((p) => p.name).join(', ')}; zone ${a.zone.id}: ${a.zone.state}${a.zone.poolName ? ` (pool ${a.zone.poolName})` : ''}\n`);
  process.stdout.write(`  Issuing CA: ${a.issuer.state}${a.issuer.reason ? ` (${a.issuer.reason})` : ''}\n`);
  process.stdout.write(`  First admin: ${out.admin.username} (tenant-admin, cleared for ${out.admin.clearance}). A second factor is required at first sign-in.\n`);
  if (out.admin.enrolLink) process.stdout.write(`\nGive this single-use enrolment link to ${username} over a trusted channel. It works once, for ${out.admin.enrolHours} hours, and sets the password and the second factor together:\n\n  ${out.admin.enrolLink}\n\n`);
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

/** `exprsn-ai signer`: runs until SIGTERM or SIGINT. It reads only its own settings, never the app's. */
async function signer(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { socket: { type: 'string' }, 'key-file': { type: 'string' }, 'token-file': { type: 'string' }, 'socket-mode': { type: 'string' }, 'allow-group-read': { type: 'boolean' } } });
  const groupRead = !!values['allow-group-read'] || process.env.SIGNER_ALLOW_GROUP_READ === 'true';
  const socketPath = values.socket ?? process.env.SIGNER_SOCKET;
  const keyFile = values['key-file'] ?? process.env.SIGNER_KEY_FILE;
  const tokenFile = values['token-file'] ?? process.env.SIGNER_TOKEN_FILE;
  const modeText = values['socket-mode'] ?? process.env.SIGNER_SOCKET_MODE ?? '0600';
  if (!socketPath || !keyFile || !tokenFile) throw new Error('signer needs --socket, --key-file and --token-file (or SIGNER_SOCKET, SIGNER_KEY_FILE and SIGNER_TOKEN_FILE).');
  if (process.env.DATA_KEY) throw new Error('The signer reads its key from SIGNER_KEY_FILE only; unset DATA_KEY in its environment.');
  const key = readPrivateFile(keyFile, 'The key file', groupRead);
  if (Buffer.from(key, 'base64').length !== 32) throw new Error('The key file must hold 32 bytes, base64-encoded (openssl rand -base64 32).');
  const running = await startSigner({ socketPath, key, token: readPrivateFile(tokenFile, 'The token file', groupRead), socketMode: parseInt(modeText, 8), log: (m) => void process.stderr.write(`${m}\n`) });
  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  });
  await running.close();
}

/** Sprint 22 (B-1403): `migrate --check` reports without applying. */
async function migrateCheckCommand(db: ReturnType<typeof createDb>): Promise<void> {
  const r = await migrateCheck(db);
  if (r.state === 'behind') {
    process.stdout.write(`${r.reason}\n`);
    process.exitCode = 4;
    return;
  }
  if (!r.pending.length) {
    process.stdout.write(`Up to date: ${r.database ?? 'no migrations'} is the newest migration this build knows.\n`);
    return;
  }
  process.stdout.write(`Pending (${r.pending.length}), in order:\n${r.pending.map((m) => `  ${m}`).join('\n')}\n`);
  for (const d of r.destructive) {
    process.stdout.write(`\n${d.migration} has destructive steps (contract): instances of the previous release must be stopped first.\n`);
    for (const st of d.steps) process.stdout.write(`  ${st.op}: ${st.line}\n`);
  }
  if (!r.destructive.length) process.stdout.write('\nNo destructive steps: instances of the previous release keep working while it runs (expand only).\n');
  process.exitCode = r.destructive.length ? 3 : 2;
}

async function readStdinLines(): Promise<string[]> {
  if (process.stdin.isTTY) {
    process.stderr.write('Paste one share per line, then an empty line:\n');
    const rl = createInterface({ input: process.stdin, terminal: false });
    const out: string[] = [];
    for await (const line of rl) {
      if (!line.trim()) break;
      out.push(line.trim());
    }
    rl.close();
    return out;
  }
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8').split('\n').map((l) => l.trim()).filter(Boolean);
}

/** Sprint 22 (B-1404): rebuilds the key-encryption key; needs no configuration when --check is given. */
async function kmsRecover(argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { share: { type: 'string', multiple: true }, check: { type: 'string' }, out: { type: 'string' } } });
  if (!values.out) throw new Error('--out <file> is required: the key is written to a new file, never printed.');
  const shares = values.share?.length ? values.share : await readStdinLines();
  if (!shares.length) throw new Error('No shares given (--share, or one per line on stdin).');
  const escrowId = decodeShare(shares[0]!).escrowId;
  let check = values.check?.trim().toLowerCase() ?? null;
  let db: ReturnType<typeof createDb> | null = null;
  try {
    if (!check) {
      try {
        db = createDb(loadConfig());
        check = (await escrowById(db, escrowId))?.key_check ?? null;
      } catch (err) {
        throw new Error(`The escrow record could not be read (${(err as Error).message.split('\n')[0]}). Pass --check with the key check value printed by kms:escrow.`, { cause: err });
      }
      if (!check) throw new Error(`Escrow ${escrowId} is not in this database. Pass --check with the key check value printed by kms:escrow.`);
    }
    const r = recoverKey(shares, check);
    writeFileSync(values.out, r.key.toString('base64') + '\n', { mode: 0o600, flag: 'wx' });
    if (db) await db('kms_escrows').where({ id: r.escrowId }).update({ verified_at: Date.now() }).catch(() => undefined);
    process.stdout.write(`Rebuilt the key of escrow ${r.escrowId} from ${r.used} shares; it matches key check value ${check}. Written to ${values.out} (mode 0600). Point DATA_KEY_FILE at it.\n`);
  } finally {
    await db?.destroy();
  }
}

/** Sprint 22 (B-1404): splits DATA_KEY into shares, printed once. */
async function kmsEscrow(s: Services, argv: string[]): Promise<void> {
  const { values } = parseArgs({ args: argv, options: { shares: { type: 'string' }, threshold: { type: 'string' }, 'key-file': { type: 'string' }, 'allow-group-read': { type: 'boolean' } } });
  const n = Number(values.shares ?? 5);
  const k = Number(values.threshold ?? 3);
  if (!Number.isInteger(n) || !Number.isInteger(k) || k < 2 || n < k || n > 255) throw new Error('--threshold must be at least 2 and at most --shares, and --shares at most 255.');
  if (s.cfg.KMS_PROVIDER !== 'local') throw new Error('kms:escrow splits the local key-encryption key. With OpenBao, use its own unseal and recovery key shares.');
  // With the signer (Sprint 20) the key is only in the signer's key file, so it is read from there.
  const keyText = values['key-file'] ? readPrivateFile(values['key-file'], 'The key file', !!values['allow-group-read']) : s.cfg.DATA_KEY;
  if (!keyText) throw new Error('kms:escrow needs the key-encryption key: DATA_KEY (or DATA_KEY_FILE), or --key-file <the signer key file> when the signer holds it.');
  const key = Buffer.from(keyText.trim(), 'base64');
  if (key.length !== 32) throw new Error('The key-encryption key must be 32 bytes, base64-encoded.');
  const e = escrowKey(key, k, n);
  await recordEscrow(s.db, e, 'cli');
  const tenant = await s.tenants.bySlug(s.cfg.DEFAULT_TENANT);
  if (tenant) await s.audit.append({ tenantId: tenant.id, action: 'kms.escrow.created', kind: 'system', actor: { service: 'cli' }, target: { escrow: e.id }, detail: { threshold: k, shares: n, keyCheck: e.keyCheck } });
  process.stdout.write(`Escrow ${e.id}: ${n} shares, any ${k} rebuild the key-encryption key.\nKey check value: ${e.keyCheck}\n\nEach share is shown this once and is not stored. Give each to a different custodian; keep the key check value with the backup runbook.\n\n`);
  e.shares.forEach((sh, i) => process.stdout.write(`Share ${i + 1} of ${n}:\n  ${sh}\n`));
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === '--help' || cmd === '-h') {
    process.stdout.write(USAGE);
    return;
  }
  if (cmd === 'signer') {
    await signer(rest);
    return;
  }
  // Sprint 22: recovery runs before the configuration is loaded: in a disaster DATA_KEY is what is missing.
  if (cmd === 'kms:recover') {
    await kmsRecover(rest);
    return;
  }
  const cfg = loadConfig();
  const log = createLogger(cfg.LOG_LEVEL === 'info' ? 'warn' : cfg.LOG_LEVEL, false);
  const db = createDb(cfg);
  let s: Services | undefined;
  try {
    if (cmd === 'migrate' && rest.includes('--check')) {
      await migrateCheckCommand(db);
      return;
    }
    // Sprint 22 (B-1403): a build older than the database never runs commands against it.
    const schema = await schemaStatus(db);
    if (schema.state === 'behind') throw new Error(schema.reason ?? 'The database schema is newer than this build');
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
      case 'tenant:create':
        await tenantCreate(s, rest);
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
        const r = await rewrapAll({ db, blobs: s.blobs, target, previous, kekName: (scope) => s!.keys.kekName(scope), progress: (m) => void process.stderr.write(`${m}\n`), keys: s.keys });
        const tenant = await s.tenants.bySlug(cfg.DEFAULT_TENANT);
        if (tenant) await s.audit.append({ tenantId: tenant.id, action: 'kms.rewrapped', kind: 'system', actor: { service: 'cli' }, target: { kms: target.kind }, detail: { previous: previous.kind, dataKeys: { ...r.dataKeys, failed: r.dataKeys.failed.length }, checkpoints: { ...r.checkpoints, failed: r.checkpoints.failed.length }, backups: { ...r.backups, failed: r.backups.failed.length }, images: { ...r.images, failed: r.images.failed.length }, modelCards: { ...r.modelCards, failed: r.modelCards.failed.length }, verified: r.verified } });
        process.stdout.write(JSON.stringify(r, null, 2) + '\n');
        (target as { client?: { close(): void } }).client?.close();
        process.stdout.write(r.verified ? 'Every data key opens with the new key-encryption key. The previous key can be removed.\n' : 'Not finished: fix the failures above and run kms:rewrap again. Keep the previous key until it reports verified.\n');
        if (!r.verified) process.exitCode = 2;
        break;
      }
      case 'kms:escrow':
        await kmsEscrow(s, rest);
        break;
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
      // Sprint 24c (B-2103)
      case 'plugins':
        process.exitCode = await pluginsCommand(s, rest, (t) => void process.stdout.write(t));
        break;
      case 'events':
        process.exitCode = await eventsCommand(s, rest, (t) => void process.stdout.write(t));
        break;
      // Sprint 25 (B-1607)
      case 'pki':
        process.exitCode = await pkiCommand(s, rest, (t) => void process.stdout.write(t));
        break;
      // Sprint 26a (B-2103, B-1805)
      case 'secrets':
        process.exitCode = await secretsCommand(s, rest, (t) => void process.stdout.write(t));
        break;
      case 'users':
        process.exitCode = await usersCommand(s, rest, (t) => void process.stdout.write(t));
        break;
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
