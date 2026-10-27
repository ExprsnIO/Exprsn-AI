/*
 * The job queue in BullMQ mode hands queued, due jobs back to the worker's queue (redispatch): the jobs a process
 * without a queue connection queued, and the ones the worker passed over while their type was paused.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { JobQueue } from '../src/platform/jobs.js';
import { harness, type Harness } from './helpers.js';

describe('JobQueue.redispatch (BullMQ mode)', () => {
  let h: Harness;
  afterEach(async () => {
    await h?.close();
  });

  it('adds a queue entry for each queued, due job of a type that is not paused, and none otherwise', async () => {
    h = await harness({});
    // the queue connection and the tick's step are private: the test reaches them by name
    const jobs = h.s.jobs as unknown as Pick<JobQueue, 'register' | 'enqueue' | 'setPaused'> & { queue: unknown; redispatch(limit?: number): Promise<number> };
    const added: { id: string; jobId: string }[] = [];
    // No queue connection: nothing to hand jobs to (the database mode, and a script).
    expect(await jobs.redispatch()).toBe(0);
    jobs.queue = { add: async (_name: string, data: { id: string }, opts: { jobId: string }) => void added.push({ id: data.id, jobId: opts.jobId }), close: async () => undefined };
    jobs.register('test.redispatch', async () => ({ ok: true }));
    jobs.register('test.paused', async () => ({ ok: true }));
    const due = await jobs.enqueue({ tenantId: h.tenantId, type: 'test.redispatch', payload: {} });
    const later = await jobs.enqueue({ tenantId: h.tenantId, type: 'test.redispatch', payload: {}, runAt: Date.now() + 3_600_000 });
    const paused = await jobs.enqueue({ tenantId: h.tenantId, type: 'test.paused', payload: {} });
    const done = await jobs.enqueue({ tenantId: h.tenantId, type: 'test.redispatch', payload: {} });
    await h.s.db('jobs').where({ id: done.id }).update({ state: 'succeeded' });
    added.length = 0; // enqueue dispatched each job once already
    jobs.setPaused(['test.paused']);

    const n = await jobs.redispatch();
    const mine = added.filter((a) => [due.id, later.id, paused.id, done.id].includes(a.id));
    expect(mine).toEqual([{ id: due.id, jobId: `${due.id}-0` }]);
    expect(n).toBeGreaterThanOrEqual(1);

    // Resumed: the job the pause held back gets its entry at the next round.
    jobs.setPaused([]);
    added.length = 0;
    await jobs.redispatch();
    expect(added.map((a) => a.id)).toEqual(expect.arrayContaining([due.id, paused.id]));
    expect(added.map((a) => a.id)).not.toContain(later.id);
    expect(added.map((a) => a.id)).not.toContain(done.id);
    jobs.queue = null;
  });

  it('runs at most the limit of one job type at a time and leaves the other slots to other types', async () => {
    h = await harness({ JOB_TYPE_LIMITS: 'test.long=2', JOB_CONCURRENCY: '4' });
    const jobs = h.s.jobs;
    expect(jobs.typeLimit('test.long')).toBe(2);
    expect(jobs.typeLimit('test.short')).toBeNull();
    let long = 0;
    let most = 0;
    const release: (() => void)[] = [];
    jobs.register('test.long', async () => {
      most = Math.max(most, ++long);
      await new Promise<void>((r) => release.push(r));
      long--;
      return { ok: true };
    });
    const ranShort: string[] = [];
    jobs.register('test.short', async (_p, ctx) => void ranShort.push(ctx.job.id));
    const longIds: string[] = [];
    for (let i = 0; i < 5; i++) longIds.push((await jobs.enqueue({ tenantId: h.tenantId, type: 'test.long', payload: {} })).id);
    const short = [(await jobs.enqueue({ tenantId: h.tenantId, type: 'test.short', payload: {} })).id, (await jobs.enqueue({ tenantId: h.tenantId, type: 'test.short', payload: {} })).id];
    const states = async (ids: string[]) => ((await h.s.db('jobs').whereIn('id', ids).select('id', 'state')) as { id: string; state: string }[]).reduce<Record<string, number>>((a, r) => ({ ...a, [r.state]: (a[r.state] ?? 0) + 1 }), {});
    const until = async (cond: () => Promise<boolean>) => { for (let i = 0; i < 200 && !(await cond()); i++) await new Promise((r) => setTimeout(r, 15)); };
    const waitFor = (n: number) => until(async () => release.length >= n);
    jobs.start(); // the test harness leaves the workers off; this test is about what they pick

    // Two long jobs start; the short ones run although five long jobs were queued before them.
    await waitFor(2);
    await until(async () => ranShort.length === 2);
    expect(ranShort.sort()).toEqual([...short].sort());
    expect(await states(longIds)).toEqual({ running: 2, queued: 3 });
    expect(most).toBe(2);
    // Each long job that ends lets the next one start, never more than two at once.
    for (let done = 0; done < 5; done++) {
      release.shift()!();
      if (done < 3) await waitFor(2);
    }
    await until(async () => (await states(longIds)).succeeded === 5);
    expect(await states(longIds)).toEqual({ succeeded: 5 });
    expect(most).toBe(2);
    await jobs.stop();
  });
});
