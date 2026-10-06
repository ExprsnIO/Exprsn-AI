/*
 * B-3606: captures a real DAV client's traffic against a throwaway server.
 *
 *   npx tsx test/dav-capture/capture.ts --out <dir> [--port 55540]
 *
 * Starts the server on 127.0.0.1:<port+1> with SQLite in a temporary directory, makes a member `exprsntest` with a
 * DAV-only app password (CalDAV and CardDAV), and puts a recording proxy on 127.0.0.1:<port> in front of it. Every
 * request and response through the proxy is appended to <out>/exchanges.jsonl, with the Authorization header and the
 * app password redacted. The credentials go to <out>/credentials.txt (mode 0600) and stdout. Point the client at
 * http(s)://127.0.0.1:<port>/ and stop with SIGINT or SIGTERM; the database is deleted on exit. `to-fixture.ts` turns
 * the recording into a replayable fixture (test/fixtures/dav/*.json).
 */
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { bootstrap } from '../../src/bootstrap.js';
import { createDb, migrate } from '../../src/db/knex.js';
import { createApp } from '../../src/http/app.js';
import { createLogger, Metrics } from '../../src/observability/index.js';
import { createServices } from '../../src/services.js';
import { testConfig } from '../helpers.js';

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

const port = Number(arg('port') ?? 55540);
const out = path.resolve(arg('out') ?? 'dav-capture-out');
mkdirSync(out, { recursive: true });
const dir = mkdtempSync(path.join(tmpdir(), 'exprsn-davcap-'));

const cfg = testConfig({ SQLITE_FILENAME: path.join(dir, 'capture.db'), BLOB_DIR: path.join(dir, 'blobs'), API_RATE_PER_MINUTE: '100000', PUBLIC_URL: `http://127.0.0.1:${port}` });
const db = createDb(cfg);
await migrate(db);
const s = createServices(cfg, db, createLogger('silent', false), new Metrics());
await bootstrap(s);
const tenant = (await s.tenants.bySlug(cfg.DEFAULT_TENANT))!;
const ws = await s.tenants.createWorkspace(tenant.id, 'Capture', 'internal');
const user = await s.users.create(tenant.id, { username: 'exprsntest', displayName: 'Exprsn Test', clearance: 'internal' });
await s.db('users').where({ id: user.id }).update({ email: 'exprsntest@example.test' });
await s.users.setRoles(user.id, 'direct', ['member']);
await s.tenants.addMember(ws.id, user.id);
const { password } = await s.dav.passwords.create({ tenantId: tenant.id, userId: user.id, name: 'Exprsn test', scopes: ['caldav', 'carddav'], ttlDays: null });
s.jobs.start();

const app = createApp(s);
const server = await new Promise<Server>((resolve) => {
  const srv = app.listen(port + 1, '127.0.0.1', () => resolve(srv));
});

const redact = (t: string) => t.split(password).join('<app-password>');
const log = path.join(out, 'exchanges.jsonl');
let seq = 0;
const handler = (req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const n = ++seq;
    const at = new Date().toISOString();
    const up = http.request({ host: '127.0.0.1', port: port + 1, method: req.method, path: req.url, headers: req.headers }, (ur) => {
      const rc: Buffer[] = [];
      ur.on('data', (c: Buffer) => rc.push(c));
      ur.on('end', () => {
        const rbody = Buffer.concat(rc);
        const headers = { ...req.headers };
        if (headers.authorization) headers.authorization = `${headers.authorization.split(' ')[0]} <redacted>`;
        appendFileSync(log, JSON.stringify({ seq: n, at, request: { method: req.method, path: req.url, headers, body: redact(body.toString('utf8')) }, response: { status: ur.statusCode, headers: ur.headers, body: redact(rbody.toString('utf8')) } }) + '\n');
        res.writeHead(ur.statusCode ?? 502, ur.headers);
        res.end(rbody);
      });
    });
    up.on('error', (e) => {
      res.writeHead(502);
      res.end(String(e));
    });
    up.end(body);
  });
};
// Apple's clients send Basic credentials only over TLS: --tls-cert/--tls-key (a throwaway CA's leaf for 127.0.0.1).
const tlsCert = arg('tls-cert');
const tlsKey = arg('tls-key');
const proxy = tlsCert && tlsKey ? https.createServer({ cert: readFileSync(tlsCert), key: readFileSync(tlsKey) }, handler) : http.createServer(handler);
const scheme = tlsCert && tlsKey ? 'https' : 'http';
await new Promise<void>((r) => proxy.listen(port, '127.0.0.1', () => r()));

writeFileSync(path.join(out, 'credentials.txt'), `url: ${scheme}://127.0.0.1:${port}/\nusername: exprsntest\npassword: ${password}\nuser id: ${user.id}\n`, { mode: 0o600 });
process.stdout.write(`Recording proxy ${scheme}://127.0.0.1:${port}/ -> server :${port + 1}\nusername: exprsntest\nuser id: ${user.id}\nlog: ${log}\n`);

const stop = async () => {
  proxy.closeAllConnections();
  server.closeAllConnections();
  await new Promise<void>((r) => proxy.close(() => r()));
  await new Promise<void>((r) => server.close(() => r()));
  await s.close();
  await db.destroy();
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
