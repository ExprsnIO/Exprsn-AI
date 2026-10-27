import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { totp } from '../src/identity/totp.js';
import request from 'supertest';
import type { Express } from 'express';
import { loadConfig, type Config } from '../src/config/index.js';
import { createDb, migrate } from '../src/db/knex.js';
import { createApp } from '../src/http/app.js';
import { createLogger, Metrics } from '../src/observability/index.js';
import { createServices, type ServiceOverrides, type Services } from '../src/services.js';
import { bootstrap } from '../src/bootstrap.js';
import { hashPassword } from '../src/identity/passwords.js';
import { closeLoopback, serveOnLoopback } from './loopback.js';
import type { Label } from '../src/authz/labels.js';

export const PASSWORD = 'correct horse battery staple';

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DB_CLIENT: 'sqlite',
    SQLITE_FILENAME: ':memory:',
    SESSION_SECRET: randomBytes(32).toString('hex'),
    DATA_KEY: randomBytes(32).toString('base64'),
    PUBLIC_URL: 'http://localhost:8080',
    WEB_ROOT: '/nonexistent',
    BLOB_DIR: mkdtempSync(path.join(tmpdir(), 'exprsn-blobs-')),
    JOB_QUEUE: 'db',
    // 1.6.0 (B-8401): AI fills run at once in tests; the debounce has its own test.
    APPS_AI_DEBOUNCE_MS: '0',
    // The variables the tests' user stores and upstream IdPs reference.
    SECRET_REF_ENV: 'LDAP_*,HR_*,SYNC_HR_*,UPSTREAM_SECRET_*,NOT_SET_ANYWHERE',
    ...overrides
  } as NodeJS.ProcessEnv);
}

/**
 * QA-1: `TEST_HARNESS_DB=pg` (with TEST_PG_URL) or `=mysql` (with TEST_MYSQL_ADMIN_URL, an account that may create
 * databases) runs `harness` and `harnessWith` on a fresh database of that engine, created here and dropped on close,
 * instead of in-memory SQLite: `TEST_HARNESS_DB=pg npx vitest run test/flags.test.ts`. Unset (the default), nothing
 * changes. Tests that build their own database with `createDb(testConfig())` stay on SQLite.
 */
export async function harnessDatabase(): Promise<{ env: Record<string, string>; drop: () => Promise<void> }> {
  const engine = process.env.TEST_HARNESS_DB;
  if (!engine) return { env: {}, drop: async () => undefined };
  const admin = engine === 'pg' ? process.env.TEST_PG_URL : engine === 'mysql' ? process.env.TEST_MYSQL_ADMIN_URL : undefined;
  if (!admin) throw new Error(`TEST_HARNESS_DB=${engine} needs ${engine === 'mysql' ? 'TEST_MYSQL_ADMIN_URL' : 'TEST_PG_URL'} (pg or mysql)`);
  const client = engine as 'pg' | 'mysql';
  const name = `h_${randomBytes(6).toString('hex')}`;
  const root = createDb({ DB_CLIENT: client, DATABASE_URL: admin, SQLITE_FILENAME: ':memory:', DB_POOL_MAX: 1 } as Config);
  try {
    await root.raw(client === 'pg' ? `CREATE DATABASE ${name}` : `CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4`);
  } finally {
    await root.destroy();
  }
  const url = new URL(admin);
  url.pathname = `/${name}`;
  return {
    env: { DB_CLIENT: client, DATABASE_URL: url.toString() },
    drop: async () => {
      const r = createDb({ DB_CLIENT: client, DATABASE_URL: admin, SQLITE_FILENAME: ':memory:', DB_POOL_MAX: 1 } as Config);
      try {
        await r.raw(client === 'pg' ? `DROP DATABASE IF EXISTS ${name} WITH (FORCE)` : `DROP DATABASE IF EXISTS \`${name}\``);
      } finally {
        await r.destroy();
      }
    }
  };
}

export interface Harness {
  s: Services;
  app: Express;
  tenantId: string;
  close(): Promise<void>;
}

export async function harness(overrides: Record<string, string> = {}, services: ServiceOverrides = {}): Promise<Harness> {
  const where = await harnessDatabase();
  const cfg = testConfig({ ...overrides, ...where.env });
  const db = createDb(cfg);
  await migrate(db);
  const s = createServices(cfg, db, createLogger('silent', false), new Metrics(), services);
  await bootstrap(s);
  const tenant = await s.tenants.bySlug(cfg.DEFAULT_TENANT);
  const app = createApp(s);
  await serveOnLoopback(app);
  return {
    s,
    app,
    tenantId: tenant!.id,
    close: async () => {
      await closeLoopback(app);
      await s.close();
      await db.destroy();
      await where.drop();
    }
  };
}

/** Creates an account in the tenant's local store, as the CLI does. */
export async function localUser(h: Harness, username: string, roles: string[], clearance: Label = 'internal') {
  const local = (await h.s.providers.list(h.tenantId)).find((p) => p.kind === 'local')!;
  const user = await h.s.users.create(h.tenantId, { username, displayName: username.toUpperCase(), clearance });
  await h.s.users.update(h.tenantId, user.id, { clearance_direct: clearance });
  await h.s.db('local_credentials').insert({ user_id: user.id, password_hash: await hashPassword(PASSWORD), updated_at: Date.now() });
  await h.s.users.upsertIdentity(user.id, local.id, user.id, []);
  await h.s.users.setRoles(user.id, 'direct', roles);
  return user;
}

export interface Client {
  agent: ReturnType<typeof request.agent>;
  csrf: string;
  cookie: string;
}

const cookieOf = (res: request.Response): string => {
  const set = res.headers['set-cookie'] as unknown as string[] | undefined;
  return (set ?? []).map((c) => c.split(';')[0]).join('; ');
};

/** Signs in with a password; returns the agent (cookie jar), CSRF token and raw login response. */
export async function login(h: Harness, username: string, password = PASSWORD) {
  const agent = request.agent(h.app);
  const res = await agent.post('/api/auth/login').send({ username, password });
  return { agent, res, csrf: res.body.csrf as string, cookie: cookieOf(res) };
}

/** Signs in an admin: password, then TOTP enrolment on first sign-in. Returns an active, MFA-verified client. */
export async function loginAdmin(h: Harness, username: string): Promise<Client & { totpSecret: string; enrolCode: string }> {
  const { agent, res } = await login(h, username);
  // A role that needs no second factor (Cloud operator since 2026-10-20) signs in active: enrol one anyway on that
  // session, so every caller gets the same MFA-verified client.
  if (res.body.stage !== 'enroll' && res.body.stage !== 'active') throw new Error(`expected enroll or active stage, got ${JSON.stringify(res.body)}`);
  const begin = await agent.post('/api/me/mfa/totp').set('x-csrf-token', res.body.csrf).send({});
  const enrolCode = totp.generate(begin.body.secret);
  const confirm = await agent.post(`/api/me/mfa/totp/${begin.body.id}/confirm`).set('x-csrf-token', res.body.csrf).send({ code: enrolCode });
  if (confirm.status !== 201) throw new Error(`enrol failed: ${JSON.stringify(confirm.body)}`);
  return { agent, csrf: confirm.body.csrf ?? res.body.csrf, cookie: cookieOf(confirm) ?? cookieOf(res), totpSecret: begin.body.secret, enrolCode };
}
