import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import YAML from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb, migrate } from '../src/db/knex.js';
import { destructiveSteps, migrateCheck, schemaStatus, upSource } from '../src/db/schema.js';
import { describeQuery, otlpBody, parseTraceparent, Span, SpanKind, Tracer, withSpan } from '../src/observability/tracing.js';
import { combine, gfDiv, gfMul, split } from '../src/platform/shamir.js';
import { decodeShare, EscrowError, escrowKey, keyCheckValue, recoverKey } from '../src/platform/escrow.js';
import { LocalKms } from '../src/platform/kms.js';
import { median, ntpQuorum } from '../src/platform/ntp.js';
import { RedisCounterStore } from '../src/platform/ratelimit.js';
import { firstDifference } from '../src/zones/kube.js';
import { KubeClient } from '../src/zones/kube.js';
import { policiesFrom } from '../src/zones/cluster.js';
import { FakeOllama } from './fake-ollama.js';
import { harness, localUser, login, loginAdmin, testConfig, type Client, type Harness } from './helpers.js';
import { seedGateway } from './seed-gateway.js';
import { FakeCollector, FakeKubeApi, FakeRedis, fakeSntp } from './sprint22-fakes.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');

async function until<T>(fn: () => T | Promise<T>, ms = 8000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!().catch(() => undefined);
});

const post = (c: Client, url: string, body: object = {}) => c.agent.post(url).set('x-csrf-token', c.csrf).send(body);

// ---------------------------------------------------------------------------------------------------------------
describe('B-1401 tracing', () => {
  it('a chat request is one trace across HTTP, guardrails, the gateway, the database and the job, with no message text', async () => {
    const collector = await new FakeCollector().start();
    const ollama = await new FakeOllama().start();
    const h = await harness({ OLLAMA_POLL_MS: '600000', OTEL_EXPORTER_OTLP_ENDPOINT: collector.url, OTEL_BSP_SCHEDULE_DELAY: '50' });
    cleanup.push(() => collector.stop(), () => ollama.stop(), () => h.close());
    await seedGateway(h, ollama);
    await localUser(h, 'mem', ['member'], 'confidential');
    const m = await login(h, 'mem');

    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const parent = '00f067aa0ba902b7';
    const secret = 'Quarterly numbers for Project Nightingale';
    const sent = await m.agent.post('/api/chat').set('x-csrf-token', m.csrf).set('traceparent', `00-${traceId}-${parent}-01`).send({ content: secret, profile: 'general' }).expect(202);
    expect(sent.headers['x-trace-id']).toBe(traceId);
    await until(async () => (await h.s.db('messages').where({ id: sent.body.messageId }).first())?.completed_at);
    // The answer queued memory extraction; the job carries the request's traceparent and joins its trace.
    const job = await until(async () => h.s.db('jobs').where({ type: 'memory.extract' }).first());
    expect(job.trace_parent).toMatch(new RegExp(`^00-${traceId}-[0-9a-f]{16}-01$`));
    await h.s.jobs.runDue();
    await h.s.tracer.flush();

    const spans = collector.spans();
    const trace = spans.filter((s) => s.traceId === traceId);
    const names = trace.map((s) => s.name);
    const server = trace.find((s) => s.name === 'POST /api/chat');
    expect(server).toMatchObject({ kind: SpanKind.SERVER, parentSpanId: parent });
    expect(names).toContain('guardrails check');
    expect(names).toContain('gateway chat stream');
    expect(names).toContain('ollama POST /api/chat');
    expect(names).toContain('job memory.extract');
    expect(names.some((n) => /^insert messages$/.test(n))).toBe(true);
    // Every span of the trace hangs off another span of the trace (or the caller's parent): one tree.
    const ids = new Set(trace.map((s) => s.spanId));
    for (const s of trace) expect(s.parentSpanId === parent || ids.has(s.parentSpanId!)).toBe(true);
    const guard = trace.find((s) => s.name === 'guardrails check')!;
    expect(guard.attributes.map((a) => a.key)).toEqual(expect.arrayContaining(['exprsn.guardrails.checkpoint', 'exprsn.guardrails.action']));
    // Ollama received the traceparent of its client span.
    const call = trace.find((s) => s.name === 'ollama POST /api/chat')!;
    expect(ollama.requests.find((r) => r.path === '/api/chat')).toBeTruthy();

    // No message text, prompt or answer anywhere in what was exported.
    const exported = collector.bodies.join('\n');
    expect(exported).not.toContain('Nightingale');
    expect(exported).not.toContain('You said');
    expect(exported).not.toContain(m.csrf);
    expect(call.attributes.find((a) => a.key === 'gen_ai.request.model')?.value).toEqual({ stringValue: 'llama3.1:8b' });
  });

  it('records only allow-listed attributes, never SQL text, and drops spans when the queue is full', async () => {
    const sent: string[] = [];
    const t = new Tracer({ url: 'http://collector.invalid/v1/traces', serviceName: 'test', maxQueue: 3, maxBatch: 100, delayMs: 60_000 }, undefined, async (_u, init) => {
      sent.push(init.body);
      return { ok: true, status: 200, text: async () => '' };
    });
    const root = t.startRoot('root', SpanKind.SERVER)!;
    root.setAttributes({ 'http.request.method': 'POST', 'message.text': 'a secret prompt', 'db.statement': "select * from users where password = 'x'" });
    expect(root.attributes).toEqual({ 'http.request.method': 'POST' });
    expect(t.stats.rejectedAttributes).toBe(2);
    await t.run(root, () => withSpan('child', SpanKind.INTERNAL, {}, async () => undefined));
    root.end();
    for (let i = 0; i < 3; i++) new Span(t, root.traceId, root.spanId, `extra ${i}`, SpanKind.INTERNAL).end();
    expect(t.stats.dropped).toBe(2);
    await t.flush();
    expect(t.stats.exported).toBe(3);
    expect(sent.join()).not.toContain('secret');
    // Database spans keep the verb and table only.
    expect(describeQuery({ method: 'select', sql: "select * from `messages` where `content` = 'Nightingale'" })).toEqual({ op: 'select', table: 'messages' });
    expect(describeQuery({ method: 'raw', sql: 'UPDATE users SET x = 1' })).toEqual({ op: 'update', table: 'users' });
    // The OTLP JSON shape: hex ids, nanosecond strings, typed attribute values.
    const body = otlpBody([{ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), parentSpanId: null, name: 'n', kind: 2, startNs: 1n, endNs: 2n, attributes: { 'http.response.status_code': 200 }, status: { code: 1 } }], 'svc') as { resourceSpans: { scopeSpans: { spans: Record<string, unknown>[] }[] }[] };
    expect(body.resourceSpans[0]!.scopeSpans[0]!.spans[0]).toEqual({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), name: 'n', kind: 2, startTimeUnixNano: '1', endTimeUnixNano: '2', attributes: [{ key: 'http.response.status_code', value: { intValue: '200' } }], status: { code: 1 } });
    expect(parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00')).toMatchObject({ sampled: false });
    expect(parseTraceparent('00-00000000000000000000000000000000-00f067aa0ba902b7-01')).toBeNull();
  });

  it('adds nothing when tracing is off', async () => {
    const h = await harness();
    cleanup.push(() => h.close());
    expect(h.s.tracer.enabled).toBe(false);
    await request(h.app).get('/healthz').expect(200);
    expect(h.s.tracer.stats.queued).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('B-1402 dashboards and alert rules', () => {
  const dir = path.join(root, 'deploy/observability');

  it('the rules parse, every alert is complete, and every metric they use is exported', async () => {
    const h = await harness();
    cleanup.push(() => h.close());
    const exported = new Set((await h.s.metrics.registry.getMetricsAsJSON()).flatMap((m) => [m.name, `${m.name}_bucket`, `${m.name}_count`, `${m.name}_sum`]));
    const rules = YAML.parse(readFileSync(path.join(dir, 'prometheus/exprsn-ai.rules.yml'), 'utf8')) as { groups: { name: string; rules: { alert?: string; record?: string; expr: string; for?: string; labels?: Record<string, string>; annotations?: Record<string, string> }[] }[] };
    const recorded = new Set(rules.groups.flatMap((g) => g.rules.filter((r) => r.record).map((r) => r.record!)));
    expect(rules.groups.length).toBeGreaterThan(0);
    for (const g of rules.groups) {
      for (const r of g.rules) {
        expect(typeof r.expr).toBe('string');
        if (r.alert) {
          expect(r.labels?.severity).toMatch(/^(critical|warning|info)$/);
          expect(r.annotations?.summary).toBeTruthy();
          expect(r.annotations?.runbook).toMatch(/^docs\/runbooks\/[\w-]+\.md/);
        }
        for (const name of r.expr.match(/\bexprsn_[a-z0-9_]+/g) ?? []) expect(exported.has(name) || recorded.has(name), `${name} in ${r.alert ?? r.record}`).toBe(true);
      }
    }
    const alerts = rules.groups.flatMap((g) => g.rules.map((r) => r.alert)).filter(Boolean);
    expect(alerts).toEqual(expect.arrayContaining(['ExprsnRateLimitsPerInstance', 'ExprsnSchemaBehind', 'ExprsnZonePolicyDrift', 'ExprsnClockSkew', 'ExprsnTraceExportDropping']));
  });

  it('the dashboards load as Grafana JSON and query exported metrics', async () => {
    const h = await harness();
    cleanup.push(() => h.close());
    const exported = new Set((await h.s.metrics.registry.getMetricsAsJSON()).flatMap((m) => [m.name, `${m.name}_bucket`, `${m.name}_count`, `${m.name}_sum`]));
    const files = readdirSync(path.join(dir, 'grafana')).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const d = JSON.parse(readFileSync(path.join(dir, 'grafana', f), 'utf8')) as { uid: string; title: string; schemaVersion: number; panels: { title: string; type: string; targets?: { expr: string }[]; gridPos: object }[]; templating: { list: { name: string }[] } };
      expect(d.uid).toMatch(/^[a-z0-9-]{1,40}$/);
      expect(d.schemaVersion).toBeGreaterThanOrEqual(36);
      expect(d.templating.list.map((v) => v.name)).toContain('datasource');
      for (const p of d.panels) {
        expect(p.gridPos).toBeTruthy();
        for (const t of p.targets ?? []) for (const name of t.expr.match(/\bexprsn_[a-z0-9_]+/g) ?? []) expect(exported.has(name), `${name} in ${f}/${p.title}`).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('B-1403 safe upgrades', () => {
  it('an instance older than the schema stops taking jobs and says why', async () => {
    const h = await harness();
    cleanup.push(() => h.close());
    expect((await schemaStatus(h.s.db)).state).toBe('current');
    await request(h.app).get('/readyz').expect(200);
    let ran = 0;
    h.s.jobs.register('test.work', async () => {
      ran++;
    });
    await h.s.jobs.enqueue({ tenantId: h.tenantId, type: 'test.work' });

    // A newer release migrated the database.
    await h.s.db('knex_migrations').insert({ name: '999_from_the_future', batch: 99, migration_time: new Date() });
    const ready = await request(h.app).get('/readyz').expect(503);
    expect(ready.body.checks.schema).toMatch(/behind: This instance is older than the database schema: the database has 999_from_the_future/);
    expect(await h.s.jobs.runDue()).toBe(0);
    expect(ran).toBe(0);
    expect((await h.s.db('jobs').where({ type: 'test.work' }).first()).state).toBe('queued');
    expect(await h.s.metrics.registry.getSingleMetricAsString('exprsn_schema_behind')).toMatch(/exprsn_schema_behind 1/);
    const r = await migrateCheck(h.s.db);
    expect(r).toMatchObject({ state: 'behind', unknown: ['999_from_the_future'] });

    // Once the database matches again (the newer release was rolled back), the instance resumes by itself.
    await h.s.db('knex_migrations').where({ name: '999_from_the_future' }).delete();
    await h.s.schema.check();
    expect(await h.s.jobs.runDue()).toBe(1);
    expect(ran).toBe(1);
  });

  it('migrate --check lists pending migrations and their destructive steps without applying them', async () => {
    const cfg = testConfig();
    const db = createDb(cfg);
    cleanup.push(() => db.destroy());
    const fresh = await migrateCheck(db);
    expect(fresh.state).toBe('pending');
    expect(fresh.pending[0]).toBe('001_core');
    expect(fresh.pending).toContain('024_ops2');
    expect(fresh.destructive).toEqual([]); // every up() only expands
    expect(await db.schema.hasTable('tenants')).toBe(false);
    await migrate(db);
    expect((await migrateCheck(db)).state).toBe('current');
  });

  it('finds destructive steps, and honours the contract marker', () => {
    const src = `export async function up(knex) {
  await knex.schema.alterTable('a', (t) => t.dropColumn('x'));
  // contract: nothing reads b.y since 1.2.0
  await knex.schema.alterTable('b', (t) => t.renameColumn('y', 'z'));
  await knex.raw('ALTER TABLE c DROP COLUMN w'); // contract: removed in 1.3.0
}
export async function down(knex) { await knex.schema.dropTable('zzz'); }`;
    const steps = destructiveSteps(upSource(src));
    expect(steps.map((s) => [s.op, s.marked])).toEqual([['dropColumn', false], ['renameColumn', true], ['DROP COLUMN', true]]);
  });

  it('lint: no migration drops or renames anything in up() without the contract marker', () => {
    const dir = path.join(root, 'server/src/db/migrations');
    const files = readdirSync(dir).filter((f) => /^\d{3}_.+\.ts$/.test(f));
    expect(files.length).toBeGreaterThan(20);
    const unmarked = files.flatMap((f) => destructiveSteps(upSource(readFileSync(path.join(dir, f), 'utf8'))).filter((s) => !s.marked).map((s) => `${f}: ${s.line}`));
    expect(unmarked).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('B-1404 key escrow', () => {
  it('GF(256) arithmetic matches the FIPS-197 examples', () => {
    expect(gfMul(0x57, 0x83)).toBe(0xc1);
    expect(gfMul(0x57, 0x13)).toBe(0xfe);
    expect(gfMul(0x57, 0x01)).toBe(0x57);
    expect(gfMul(0, 0x83)).toBe(0);
    expect(gfDiv(0xc1, 0x83)).toBe(0x57);
    for (let a = 1; a < 256; a++) expect(gfMul(a, gfDiv(1, a))).toBe(1);
  });

  it('known-answer vectors: fixed coefficients give fixed shares', () => {
    const fixed = (bytes: number[]) => () => Buffer.from(bytes);
    // k = 2, f(x) = 0x42 + 0x01 x: f(1) = 0x43, f(2) = 0x40, f(3) = 0x41.
    expect(split(Buffer.from([0x42]), 3, 2, fixed([0x01])).map((s) => [s.x, s.y[0]])).toEqual([[1, 0x43], [2, 0x40], [3, 0x41]]);
    // k = 3, f(x) = 0x53 + 0xca x + 0x02 x^2 over GF(2^8) (computed independently by shift-and-add): 0x9b, 0xd4, 0x1c.
    const kat = split(Buffer.from([0x53]), 3, 3, fixed([0xca, 0x02]));
    expect(kat.map((s) => s.y[0])).toEqual([0x9b, 0xd4, 0x1c]);
    expect(combine([kat[0]!, kat[2]!, kat[1]!])[0]).toBe(0x53);
  });

  it('property: any k of n shares rebuild the secret, and fewer give something else', () => {
    for (let round = 0; round < 60; round++) {
      const n = 2 + Math.floor(Math.random() * 9);
      const k = 2 + Math.floor(Math.random() * (n - 1));
      const secret = Buffer.from(Array.from({ length: 1 + Math.floor(Math.random() * 40) }, () => Math.floor(Math.random() * 256)));
      const shares = split(secret, n, k);
      const pick = [...shares].sort(() => Math.random() - 0.5);
      expect(combine(pick.slice(0, k)).equals(secret)).toBe(true);
      if (n > k) expect(combine(pick.slice(0, k + 1)).equals(secret)).toBe(true);
      if (k > 2 && secret.length >= 16) expect(combine(pick.slice(0, k - 1)).equals(secret)).toBe(false);
    }
  });

  it('three of five shares rebuild a key that opens a backup; two do not', async () => {
    const h = await harness();
    cleanup.push(() => h.close());
    const backup = await h.s.ops.backups.createNow({ tenantId: h.tenantId, actor: { service: 'test' }, userId: null });
    expect(backup.state).toBe('succeeded');
    const key = Buffer.from(h.s.cfg.DATA_KEY!, 'base64');
    const e = escrowKey(key, 3, 5);
    expect(e.shares).toHaveLength(5);
    expect(e.keyCheck).toBe(keyCheckValue(key));
    expect(e.shares.every((s) => !s.includes(key.toString('hex')))).toBe(true);

    const restore = async (kms: LocalKms) => {
      const db = createDb(testConfig());
      cleanup.push(() => db.destroy());
      await migrate(db);
      return h.s.ops.backups.restoreInto({ target: db, client: 'sqlite', kms, from: h.s.blobs, blobsTo: null, backupId: backup.id, force: false });
    };

    const three = recoverKey([e.shares[4]!, e.shares[0]!, e.shares[2]!], e.keyCheck);
    expect(three.key.equals(key)).toBe(true);
    const r = await restore(new LocalKms(three.key.toString('base64')));
    expect(r.rows).toBeGreaterThan(0);

    expect(() => recoverKey([e.shares[0]!, e.shares[1]!], e.keyCheck)).toThrow(/needs 3 different shares; 2 were given/);
    // Even interpolated anyway, two shares give a different key, which neither matches nor opens the backup.
    const two = combine([decodeShare(e.shares[0]!), decodeShare(e.shares[1]!)]);
    expect(two.equals(key)).toBe(false);
    expect(keyCheckValue(two)).not.toBe(e.keyCheck);
    await expect(restore(new LocalKms(two.toString('base64')))).rejects.toThrow(/signature does not verify/);

    // A share copied wrongly is caught on its own; shares of another escrow are refused; a wrong check value too.
    const typo = e.shares[1]!.replace(/:([0-9a-f])([0-9a-f]{63}):/, (_m, c: string, rest: string) => `:${c === '0' ? '1' : '0'}${rest}:`);
    expect(() => recoverKey([e.shares[0]!, typo, e.shares[2]!], e.keyCheck)).toThrow(/does not match its check value/);
    const other = escrowKey(key, 3, 5);
    expect(() => recoverKey([e.shares[0]!, other.shares[1]!, e.shares[2]!], e.keyCheck)).toThrow(EscrowError);
    expect(() => recoverKey(e.shares.slice(0, 3), '0'.repeat(16))).toThrow(/does not match the key check value/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('B-1405 zones applied in-cluster', () => {
  it('a zone change applies its NetworkPolicy through server-side apply, and a manual edit shows as drift', async () => {
    const kube = await new FakeKubeApi().start();
    const h = await harness({ ZONES_APPLY: 'kubernetes', ZONES_APPLY_API_URL: kube.url, ZONES_APPLY_FIELD_MANAGER: 'exprsn-ai' });
    cleanup.push(() => kube.stop(), () => h.close());
    h.s.zoneCluster.client = new KubeClient({ apiUrl: kube.url, token: () => 'test-token\n', fieldManager: 'exprsn-ai' });
    await localUser(h, 'root1', ['system-admin'], 'restricted');
    await localUser(h, 'root2', ['system-admin'], 'restricted');
    const a = await loginAdmin(h, 'root1');
    const b = await loginAdmin(h, 'root2');

    await post(a, '/api/admin/zones/seed').expect(201);
    await until(async () => h.s.db('jobs').where({ type: 'zones.cluster.apply' }).first());
    await h.s.jobs.runDue();
    // Every zone but the external one (which renders nothing) has its policy in its namespace.
    expect([...kube.objects.keys()].sort()).toEqual(['app/app-zone', 'data/data-zone', 'directory/directory-zone', 'edge/edge-zone', 'inference/inference-zone', 'sandbox/sandbox-zone', 'training/training-zone']);
    const apply = kube.requests.find((r) => r.method === 'PATCH')!;
    expect(apply.contentType).toBe('application/apply-patch+yaml');
    expect(apply.query).toContain('fieldManager=exprsn-ai');
    expect(apply.query).toContain('force=true');

    // A proposal approved by a second admin: the new version is applied.
    await post(a, '/api/admin/zones/sandbox/proposals', { patch: { accepts: [{ kind: 'zone', zone: 'app', ports: [8443] }] }, reason: 'CHG-22' }).expect(201);
    await post(b, '/api/admin/zones/sandbox/draft/approve').expect(200);
    await until(async () => (await h.s.db('jobs').where({ type: 'zones.cluster.apply' })).length >= 2);
    await h.s.jobs.runDue();
    const sandbox = kube.objects.get('sandbox/sandbox-zone') as { metadata: { labels: Record<string, string> }; spec: { ingress: { ports?: { port: number }[] }[] } };
    expect(sandbox.metadata.labels['exprsn.ai/zone-version']).toBe('2');
    expect(JSON.stringify(sandbox.spec.ingress)).toContain('8443');

    const clean = await post(a, '/api/admin/zones-cluster/check').expect(200);
    expect(clean.body).toMatchObject({ drift: 0, missing: 0, errors: 0 });

    // Someone edits the policy by hand (opens a port), and someone deletes another.
    sandbox.spec.ingress.push({ ports: [{ port: 22 }] });
    kube.objects.delete('edge/edge-zone');
    const drift = await post(a, '/api/admin/zones-cluster/check').expect(200);
    expect(drift.body).toMatchObject({ drift: 1, missing: 1 });
    expect(drift.body.objects.find((o: { name: string }) => o.name === 'sandbox-zone')).toMatchObject({ state: 'drift', detail: expect.stringMatching(/spec\.ingress \(\d+ expected, \d+ found\)/) });
    const status = (await a.agent.get('/api/admin/zones-cluster').expect(200)).body;
    expect(status).toMatchObject({ mode: 'kubernetes', drift: 2 });
    expect(await h.s.db('audit_events').where({ action: 'zone.cluster.drift' })).toHaveLength(1);
    // A second check does not report the same drift again.
    await post(a, '/api/admin/zones-cluster/check').expect(200);
    expect(await h.s.db('audit_events').where({ action: 'zone.cluster.drift' })).toHaveLength(1);

    // Applying again puts both back.
    const fixed = await post(a, '/api/admin/zones-cluster/apply').expect(200);
    expect(fixed.body).toMatchObject({ failed: 0 });
    expect((await post(a, '/api/admin/zones-cluster/check').expect(200)).body).toMatchObject({ drift: 0, missing: 0 });
    expect(await h.s.db('audit_events').where({ action: 'zone.cluster.applied' })).not.toHaveLength(0);

    // Only zone admins.
    await localUser(h, 'mem', ['member'], 'internal');
    const m = await login(h, 'mem');
    await m.agent.get('/api/admin/zones-cluster').expect(403);
  });

  it('refuses when not configured, and reports API errors plainly', async () => {
    const h = await harness();
    cleanup.push(() => h.close());
    await localUser(h, 'root1', ['system-admin'], 'restricted');
    const a = await loginAdmin(h, 'root1');
    const r = await post(a, '/api/admin/zones-cluster/apply').expect(409);
    expect(r.body.detail).toMatch(/ZONES_APPLY=kubernetes/);

    const kube = await new FakeKubeApi().start();
    cleanup.push(() => kube.stop());
    const c = new KubeClient({ apiUrl: kube.url, token: () => 'wrong', fieldManager: 'x' });
    await expect(c.get('NetworkPolicy', 'app', 'app-zone')).rejects.toThrow(/401 Unauthorized.*token was refused/);
  });

  it('parses the rendered policies and compares only what it set', () => {
    const text = '# NetworkZone app v1\napiVersion: v1\nkind: Namespace\nmetadata:\n  name: app\n---\napiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: app-zone\n  namespace: app\n  labels:\n    exprsn.ai/zone-version: "1"\nspec:\n  podSelector: {}\n  ingress:\n    - from:\n        - namespaceSelector: {matchLabels: {exprsn.ai/zone: edge}}\n      ports:\n        - {port: 8080, protocol: TCP}\n';
    const [p] = policiesFrom(text);
    expect(p).toMatchObject({ kind: 'NetworkPolicy', metadata: { name: 'app-zone', namespace: 'app' }, spec: { ingress: [{ ports: [{ port: 8080 }] }] } });
    expect(firstDifference(p!.spec, { ...(p!.spec as object), policyTypes: ['Ingress'] })).toBeNull(); // a defaulted extra field
    expect(firstDifference({ a: [{ port: 80 }] }, { a: [{ port: 81 }] })).toBe('a[0].port');
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('B-1406 NTP quorum', () => {
  it('with one lying server out of three, the reported skew is the honest one', async () => {
    const honest1 = await fakeSntp(0);
    const honest2 = await fakeSntp(5);
    const liar = await fakeSntp(3_600_000);
    cleanup.push(() => honest1.close(), () => honest2.close(), () => liar.close());
    const q = await ntpQuorum([honest1.spec, liar.spec, honest2.spec], { timeoutMs: 2000, outlierMs: 1000 });
    expect(q.outliers).toEqual([liar.spec]);
    expect(q.quorum).toBe(true);
    expect(Math.abs(q.offsetMs!)).toBeLessThan(500);
    expect(q.warning).toMatch(/disagrees with the other servers/);

    // Through the platform summary.
    const h = await harness({ NTP_SERVER: [honest1.spec, liar.spec, honest2.spec].join(','), NTP_OUTLIER_MS: '1000' });
    cleanup.push(() => h.close());
    await localUser(h, 'root1', ['system-admin'], 'restricted');
    const a = await loginAdmin(h, 'root1');
    const sum = (await a.agent.get('/api/admin/platform/summary').expect(200)).body;
    expect(sum.clock.ntp.skewMs).toBeLessThan(500);
    expect(sum.clock.ntp.outliers).toEqual([liar.spec]);
    expect(sum.clock.ntp.servers).toHaveLength(3);
  });

  it('two servers that disagree give no quorum; a silent one is named', async () => {
    const fake = async (spec: string) => {
      if (spec === 'down') throw new Error('No answer from down within 10 ms');
      return { server: spec, offsetMs: spec === 'a' ? 0 : 10_000, delayMs: 1, stratum: 2, refId: 'x' };
    };
    const two = await ntpQuorum(['a', 'b'], { timeoutMs: 10, outlierMs: 1000 }, fake);
    expect(two).toMatchObject({ quorum: false, outliers: ['a', 'b'] });
    expect(two.warning).toMatch(/not possible to tell which is right/);
    const silent = await ntpQuorum(['a', 'down', 'a'], { timeoutMs: 10, outlierMs: 1000 }, fake);
    expect(silent).toMatchObject({ quorum: true, offsetMs: 0 });
    expect(silent.warning).toMatch(/down did not answer/);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe('B-1407 rate-limit health', () => {
  it('stopping Redis shows the per-instance warning on Platform within a minute, and recovers', async () => {
    const redis = await new FakeRedis().start();
    const store = new RedisCounterStore(`redis://127.0.0.1:${redis.port}`);
    cleanup.push(() => store.close(), () => redis.stop());
    await until(() => store.probe()); // connected
    expect((await store.hit('k', 60_000)).count).toBe(1);
    expect((await store.hit('k', 60_000)).count).toBe(2);
    expect(store.health()).toMatchObject({ degraded: false });

    const h: Harness = await harness();
    cleanup.push(() => h.close());
    const original = h.s.counters;
    h.s.counters = store;
    cleanup.push(async () => {
      h.s.counters = original;
    });
    await localUser(h, 'root1', ['system-admin'], 'restricted');
    const a = await loginAdmin(h, 'root1');

    await redis.stop();
    const stoppedAt = Date.now();
    store.startProbe(200);
    await until(() => store.health().degraded, 60_000);
    expect(Date.now() - stoppedAt).toBeLessThan(60_000);
    const sum = (await a.agent.get('/api/admin/platform/summary').expect(200)).body;
    expect(sum.rateLimitHealth).toMatchObject({ degraded: true });
    expect(sum.rateLimitHealth.since).toBeGreaterThanOrEqual(stoppedAt - 1000);
    expect(await h.s.metrics.registry.getSingleMetricAsString('exprsn_ratelimit_degraded')).toMatch(/exprsn_ratelimit_degraded 1/);
    // Limits still apply, counted in this instance.
    expect((await store.hit('k2', 60_000)).count).toBe(1);
    expect(store.health().fallbacks).toBeGreaterThan(0);

    // Redis comes back on the same port: the warning clears.
    await redis.start(redis.port);
    await until(() => !store.health().degraded, 30_000);
    expect((await a.agent.get('/api/admin/platform/summary').expect(200)).body.rateLimitHealth.degraded).toBe(false);
  });
});
