import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { authenticator } from 'otplib';
import request from 'supertest';
import type { Express } from 'express';
import { loadConfig, type Config } from '../src/config/index.js';
import { createDb, migrate } from '../src/db/knex.js';
import { createApp } from '../src/http/app.js';
import { createLogger, Metrics } from '../src/observability/index.js';
import { createServices, type ServiceOverrides, type Services } from '../src/services.js';
import { bootstrap } from '../src/bootstrap.js';
import { hashPassword } from '../src/identity/passwords.js';
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
    // The variables the tests' user stores and upstream IdPs reference.
    SECRET_REF_ENV: 'LDAP_*,HR_*,SYNC_HR_*,UPSTREAM_SECRET_*,NOT_SET_ANYWHERE',
    ...overrides
  } as NodeJS.ProcessEnv);
}

export interface Harness {
  s: Services;
  app: Express;
  tenantId: string;
  close(): Promise<void>;
}

export async function harness(overrides: Record<string, string> = {}, services: ServiceOverrides = {}): Promise<Harness> {
  const cfg = testConfig(overrides);
  const db = createDb(cfg);
  await migrate(db);
  const s = createServices(cfg, db, createLogger('silent', false), new Metrics(), services);
  await bootstrap(s);
  const tenant = await s.tenants.bySlug(cfg.DEFAULT_TENANT);
  return {
    s,
    app: createApp(s),
    tenantId: tenant!.id,
    close: async () => {
      await s.close();
      await db.destroy();
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
  if (res.body.stage !== 'enroll') throw new Error(`expected enroll stage, got ${JSON.stringify(res.body)}`);
  const begin = await agent.post('/api/me/mfa/totp').set('x-csrf-token', res.body.csrf).send({});
  const enrolCode = authenticator.generate(begin.body.secret);
  const confirm = await agent.post(`/api/me/mfa/totp/${begin.body.id}/confirm`).set('x-csrf-token', res.body.csrf).send({ code: enrolCode });
  if (confirm.status !== 201) throw new Error(`enrol failed: ${JSON.stringify(confirm.body)}`);
  return { agent, csrf: confirm.body.csrf, cookie: cookieOf(confirm), totpSecret: begin.body.secret, enrolCode };
}
