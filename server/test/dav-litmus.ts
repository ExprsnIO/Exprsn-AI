/*
 * B-3203: runs the `litmus` WebDAV suite (https://github.com/notroj/litmus) against the file store over WebDAV.
 *
 *   npx tsx test/dav-litmus.ts --litmus /path/to/litmus [--port 55532] [--tests "basic copymove locks"]
 *
 * Starts the server on 127.0.0.1 with SQLite in a temporary directory and the database job queue (so uploads are
 * scanned before PUT answers, as in production), makes a member with a WebDAV app password and a workspace, and runs
 * litmus against `/dav/files/<workspace>/`. Exits with litmus's status. Without --litmus it prints the URL and the
 * credentials and keeps serving until interrupted (for running litmus or a client by hand). CI builds litmus from its
 * release tarball (.github/workflows/ci.yml).
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bootstrap } from '../src/bootstrap.js';
import { createDb, migrate } from '../src/db/knex.js';
import { createApp } from '../src/http/app.js';
import { createLogger, Metrics } from '../src/observability/index.js';
import { createServices } from '../src/services.js';
import { testConfig } from './helpers.js';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

const port = Number(arg('port') ?? 55532);
const litmus = arg('litmus');
const tests = arg('tests') ?? 'basic copymove locks';
const dir = mkdtempSync(path.join(tmpdir(), 'exprsn-litmus-'));

const cfg = testConfig({ SQLITE_FILENAME: path.join(dir, 'litmus.db'), BLOB_DIR: path.join(dir, 'blobs'), API_RATE_PER_MINUTE: '100000' });
const db = createDb(cfg);
await migrate(db);
const s = createServices(cfg, db, createLogger('silent', false), new Metrics());
await bootstrap(s);
const tenant = (await s.tenants.bySlug(cfg.DEFAULT_TENANT))!;
const ws = await s.tenants.createWorkspace(tenant.id, 'Litmus', 'internal');
const user = await s.users.create(tenant.id, { username: 'litmus', displayName: 'Litmus', clearance: 'internal' });
await s.users.setRoles(user.id, 'direct', ['member']);
await s.tenants.addMember(ws.id, user.id);
const { password } = await s.dav.passwords.create({ tenantId: tenant.id, userId: user.id, name: 'litmus', scopes: ['webdav'], ttlDays: null });
s.jobs.start();

const app = createApp(s);
const server = await new Promise<Server>((resolve) => {
  const srv = app.listen(port, '127.0.0.1', () => resolve(srv));
});
const url = `http://127.0.0.1:${port}/dav/files/${ws.slug || ws.id}/`;

const stop = async (code: number) => {
  await new Promise<void>((r) => server.close(() => r()));
  await s.close();
  await db.destroy();
  rmSync(dir, { recursive: true, force: true });
  process.exit(code);
};

if (!litmus) {
  process.stdout.write(`Serving ${url}\nusername: litmus\npassword: ${password}\n`);
  process.on('SIGINT', () => void stop(0));
} else {
  const child = spawn(litmus, ['-k', url, 'litmus', password], { stdio: 'inherit', env: { ...process.env, TESTS: tests }, cwd: dir });
  child.on('exit', (code) => void stop(code ?? 1));
}
