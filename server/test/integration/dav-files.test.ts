/*
 * B-32 (the file store over WebDAV) against real databases. Each block runs when its variable is set:
 *
 *   TEST_PG_URL / TEST_MYSQL_URL   migration 036c_dav_files; a PUT scanned before it answers and readable after; a
 *                                  second PUT kept as a version; a folder moved with its file's versions; a lock that
 *                                  refuses a change without its token and allows it with one (the lock row's
 *                                  root hash and expiry); UNLOCK. The app listens on 127.0.0.1:${TEST_DAV_FILES_PORT:-55534}.
 */
import type { Server } from 'node:http';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';
import { createDb, migrate } from '../../src/db/knex.js';
import { migrationSource } from '../../src/db/migrations/index.js';
import { createApp } from '../../src/http/app.js';
import { createLogger, Metrics } from '../../src/observability/index.js';
import { createServices } from '../../src/services.js';
import { testConfig } from '../helpers.js';

const PORT = Number(process.env.TEST_DAV_FILES_PORT ?? 55534);

for (const d of [
  { name: 'PostgreSQL', client: 'pg' as const, url: process.env.TEST_PG_URL },
  { name: 'MySQL', client: 'mysql' as const, url: process.env.TEST_MYSQL_URL }
]) {
  describe.skipIf(!d.url)(`WebDAV file store on ${d.name}`, () => {
    it('migrates 036c_dav_files and serves files, versions, moves and locks', async () => {
      const cfg = testConfig({ DB_CLIENT: d.client, DATABASE_URL: d.url! });
      const db = createDb(cfg);
      await db.migrate.rollback({ migrationSource }, true).catch(() => undefined);
      await migrate(db);
      const s = createServices(cfg, db, createLogger('silent', false), new Metrics());
      let server: Server | null = null;
      try {
        expect(await db.schema.hasTable('dav_locks')).toBe(true);
        await bootstrap(s);
        const tenant = (await s.tenants.bySlug(cfg.DEFAULT_TENANT))!;
        const ws = await s.tenants.createWorkspace(tenant.id, 'Drive', 'internal');
        const u = await s.users.create(tenant.id, { username: 'dee', displayName: 'Dee', clearance: 'internal' });
        await s.users.setRoles(u.id, 'direct', ['member']);
        await s.tenants.addMember(ws.id, u.id);
        const { password } = await s.dav.passwords.create({ tenantId: tenant.id, userId: u.id, name: 'Finder', scopes: ['webdav'], ttlDays: null });
        const app = createApp(s);
        server = await new Promise<Server>((resolve) => {
          const srv = app.listen(PORT, '127.0.0.1', () => resolve(srv));
        });
        const dav = (method: string, path: string) => (request(`http://127.0.0.1:${PORT}`) as unknown as Record<string, (p: string) => request.Test>)[method.toLowerCase()]!(path).auth('dee', password);
        const root = `/dav/files/${ws.slug || ws.id}`;

        await dav('MKCOL', `${root}/A/`).expect(201);
        await dav('MKCOL', `${root}/B/`).expect(201);
        await dav('PUT', `${root}/A/f.txt`).send('one\n').expect(201);
        await dav('PUT', `${root}/A/f.txt`).send('two\n').expect(204);
        const file = await db('files').where({ name: 'f.txt' }).first();
        expect((await db('file_versions').where({ file_id: file.id }).orderBy('number')).map((v: { state: string }) => v.state)).toEqual(['ready', 'ready']);
        await dav('MOVE', `${root}/A/`).set('Destination', `${root}/B/A/`).expect(201);
        expect((await dav('GET', `${root}/B/A/f.txt`).expect(200)).text).toBe('two\n');
        expect(Number((await db('file_versions').where({ file_id: file.id }).count({ n: '*' }))[0]!.n)).toBe(2);

        const lock = await dav('LOCK', `${root}/B/A/f.txt`).send('<?xml version="1.0"?><d:lockinfo xmlns:d="DAV:"><d:lockscope><d:exclusive/></d:lockscope><d:locktype><d:write/></d:locktype></d:lockinfo>').expect(200);
        const token = /<([^>]+)>/.exec(lock.headers['lock-token'] as string)![1]!;
        const row = await db('dav_locks').where({ token }).first();
        expect(row.root_hash).toMatch(/^[0-9a-f]{64}$/);
        expect(Number(row.expires_at)).toBeGreaterThan(Date.now());
        await dav('PUT', `${root}/B/A/f.txt`).send('three\n').expect(423);
        await dav('PUT', `${root}/B/A/f.txt`).set('If', `(<${token}>)`).send('three\n').expect(204);
        await dav('UNLOCK', `${root}/B/A/f.txt`).set('Lock-Token', `<${token}>`).expect(204);
        expect(await db('dav_locks').where({ token }).first()).toBeUndefined();
      } finally {
        if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
        await s.close();
        await db.destroy();
      }
    });
  });
}
