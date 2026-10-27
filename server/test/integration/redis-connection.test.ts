/*
 * 1.9.0: the Redis connection driver on a real server.
 *   TEST_REDIS_URL   redis://[user:password@]localhost:6379[/db]   keys under `exprsn-it:` are written and removed
 */
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseAllowList } from '../../src/mcp/hosts.js';
import { classifyRedis, RedisDriver } from '../../src/connections/redis.js';

const URL_ = process.env.TEST_REDIS_URL;

describe.skipIf(!URL_)('Redis connection driver (TEST_REDIS_URL)', () => {
  const u = new URL(URL_ ?? 'redis://localhost:6379');
  const seed = new Redis(URL_ ?? '', { lazyConnect: true });
  const driver = () =>
    new RedisDriver({ engine: 'redis', endpoint: `${u.hostname}:${u.port || 6379}`, database: u.pathname.slice(1) || '0', tls: u.protocol === 'rediss:', username: decodeURIComponent(u.username) || null, password: decodeURIComponent(u.password) || null, options: { scanLimit: 100_000 } }, parseAllowList(u.hostname));
  const run = (q: string, limit = 50) => driver().query(classifyRedis(q, null), q, { limit, timeoutMs: 5000 });

  beforeAll(async () => {
    await seed.connect();
    await seed.hset('exprsn-it:user:1', { name: 'Ana', email: 'ana@example.org' });
    await seed.rpush('exprsn-it:list', ...Array.from({ length: 20 }, (_, i) => `v${i}`));
    await seed.zadd('exprsn-it:board', 3, 'a', 2, 'b', 1, 'c');
    await seed.xadd('exprsn-it:events', '*', 'order', '1');
  });
  afterAll(async () => {
    await seed.del('exprsn-it:user:1', 'exprsn-it:list', 'exprsn-it:board', 'exprsn-it:events');
    await seed.quit();
  });

  it('tests, introspects and reads', async () => {
    const t = await driver().test(5000);
    expect(t.version).toMatch(/^Redis \d/);
    const schema = await driver().introspect(5000);
    expect(schema.map((o) => o.name)).toContain('exprsn-it:user:*');
    expect((await run('HGETALL exprsn-it:user:1')).rows).toEqual(expect.arrayContaining([['name', 'Ana']]));
    expect(await run('LRANGE exprsn-it:list 0 -1', 5)).toMatchObject({ capped: true, rows: [[0, 'v0'], [1, 'v1'], [2, 'v2'], [3, 'v3'], [4, 'v4']] });
    expect((await run('ZRANGE exprsn-it:board 0 -1 WITHSCORES')).rows).toEqual([['c', 1], ['b', 2], ['a', 3]]);
    expect((await run('XRANGE exprsn-it:events - +')).columns).toEqual(['id', 'order']);
    expect((await run('SCAN 0 MATCH exprsn-it:* COUNT 100', 100)).rows.map((r) => r[0])).toEqual(expect.arrayContaining(['exprsn-it:user:1', 'exprsn-it:list']));
  });
});
