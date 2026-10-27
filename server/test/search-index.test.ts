import { ulid } from 'ulid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { completions, fold, matchesText, parseQuery, prefixesOf, snippet, terms } from '../src/search/normalise.js';
import { harness, type Harness } from './helpers.js';
import { adminPrincipal, applySearchMigrations, count, enableIndex, person, searchHarness, settle, type Person } from './search-helpers.js';

/*
 * 1.9.0, Sprint 52 (B-170): the blind search index. No plaintext term is stored anywhere; terms are folded (case,
 * accents, a light plural fold); phrases use positions and prefixes the prefix table; edits and deletes keep the index
 * current; the backfill is resumable; a rotation re-indexes under a new key and drops the old one; without the tables
 * or with the index off, search answers as before and writes index nothing; 100,000 messages answer a query in under
 * 50 ms.
 */

const C = '/api/messaging/conversations';

describe('normalisation, queries and snippets', () => {
  it('folds case and accents, drops stop words, folds plurals lightly and keeps positions in order', () => {
    expect(fold('CAFÉ')).toBe('cafe');
    expect(terms('The Café RÉSUMÉS were naïve; the class passes')).toEqual(['cafe', 'resume', 'naive', 'class', 'passe']);
    // decomposed accents fold the same as composed ones
    expect(terms('café')).toEqual(['cafe']);
    expect(prefixesOf('marmalade')).toEqual(['ma', 'mar', 'marm']);
    expect(prefixesOf('ox')).toEqual(['ox']);
  });

  it('reads words, phrases and prefixes, and checks them on the opened text', () => {
    const pq = parseQuery('budget "state of the art" marm*');
    expect(pq.units).toEqual([
      { kind: 'term', term: 'budget' },
      { kind: 'phrase', terms: ['state', 'art'], folded: ['state', 'of', 'the', 'art'] },
      { kind: 'prefix', prefix: 'marm', folded: 'marm' }
    ]);
    expect(matchesText('The budget is state of the art, with marmalade', pq)).toBe(true);
    expect(matchesText('The budget is the art of the state, with marmalade', pq)).toBe(false);
    // type-ahead: the last word is a prefix until a space follows it
    expect(parseQuery('quarterly repo', { typeahead: true }).units.at(-1)).toEqual({ kind: 'prefix', prefix: 'repo', folded: 'repo' });
    expect(parseQuery('quarterly repo ', { typeahead: true }).units.at(-1)).toEqual({ kind: 'term', term: 'repo' });
    expect(completions('Our Reports on repos', parseQuery('rep', { typeahead: true }))).toEqual(['reports', 'repos']);
    const sn = snippet('A long preamble that goes on and on. '.repeat(10) + 'Then the Budget appears here.', parseQuery('budget'));
    expect(sn.text.startsWith('…')).toBe(true);
    const [a, b] = sn.highlights[0]!;
    expect(sn.text.slice(a, b)).toBe('Budget');
  });
});

describe('the blind index (B-170)', () => {
  let h: Harness;
  let ws: string;
  let alice: Person;
  let bob: Person;

  beforeEach(async () => {
    h = await searchHarness();
    ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Design', 'confidential')).id;
    alice = await person(h, 'alice', [ws]);
    bob = await person(h, 'bob', [ws]);
  }, 60_000);
  afterEach(async () => {
    await h.close();
  });

  const group = async () => (await alice.post(C, { kind: 'group', workspaceId: ws, title: 'Launch', memberIds: [bob.user.id] }).expect(201)).body as { id: string };
  const say = async (who: Person, conv: string, body: string) => (await who.post(`${C}/${conv}/messages`, { body }).expect(201)).body as { id: string };
  const find = async (who: Person, q: string) => (await who.get(`/api/search/messages?q=${encodeURIComponent(q)}`).expect(200)).body as { items: { id: string; snippet: string; highlights: [number, number][] }[]; total: number; engine: string };

  it('stores no plaintext term in any table, and still finds every sample word', async () => {
    await enableIndex(h);
    const g = await group();
    const m1 = await say(alice, g.id, 'Quokkazanzibar meets Marmaladefjord at noon');
    const m2 = await say(bob, g.id, 'Something else entirely');
    await bob.patch(`/api/messaging/messages/${m2.id}`, { body: 'Periwinkleoboe was the codename' }).expect(200);
    const post = (await alice.post('/api/feed/posts', { workspaceId: ws, body: 'Flamingoquartz roadmap for the year' }).expect(201)).body as { id: string };
    await bob.post(`/api/feed/posts/${post.id}/comments`, { body: 'Tangerinevelvet sounds right' }).expect(201);
    await settle(h);
    expect(await count(h, 'search_postings', { tenant_id: h.tenantId })).toBeGreaterThan(0);
    expect(await count(h, 'search_prefixes', { tenant_id: h.tenantId })).toBeGreaterThan(0);
    // found through the index
    expect((await find(bob, 'quokkazanzibar')).items.map((x) => x.id)).toEqual([m1.id]);
    expect((await find(alice, 'periwinkleoboe')).items.map((x) => x.id)).toEqual([m2.id]);
    const posts = (await bob.get('/api/search/posts?q=flamingoquartz').expect(200)).body as { items: { id: string }[]; engine: string };
    expect(posts.engine).toBe('index');
    expect(posts.items.map((x) => x.id)).toEqual([post.id]);
    expect(((await alice.get('/api/search/posts?q=tangerinevelvet').expect(200)).body as { items: { kind: string }[] }).items.map((x) => x.kind)).toEqual(['comment']);

    // every row of every table, as text: none of the sample words, in any case, nor their folded terms
    const samples = ['quokkazanzibar', 'marmaladefjord', 'periwinkleoboe', 'flamingoquartz', 'tangerinevelvet', 'something else entirely'];
    const tables = ((await h.s.db.raw("select name from sqlite_master where type = 'table' and name not like 'sqlite_%'")) as { name: string }[]).map((t) => t.name);
    expect(tables).toContain('search_postings');
    const leaks: string[] = [];
    for (const t of tables) {
      const rows = (await h.s.db(t).select('*')) as Record<string, unknown>[];
      const text = JSON.stringify(rows, (_k, v: unknown) => (Buffer.isBuffer(v) ? v.toString('latin1') : v)).toLowerCase();
      for (const w of samples) if (text.includes(w)) leaks.push(`${t}: ${w}`);
    }
    expect(leaks).toEqual([]);
  });

  it('matches folded words, phrases by position, and prefixes for type-ahead', async () => {
    await enableIndex(h);
    const g = await group();
    const accents = await say(alice, g.id, 'The CAFÉ résumés were naïve');
    const quick = await say(alice, g.id, 'the quick brown fox jumps over it');
    const swapped = await say(alice, g.id, 'brown quick fox, quick then brown');
    const art = await say(alice, g.id, 'This design is state of the art');
    const reversed = await say(alice, g.id, 'The art of the state is different');
    const marm = await say(alice, g.id, 'Marmalade on toast');
    await settle(h);
    expect((await find(bob, 'cafe resume NAIVE')).items.map((x) => x.id)).toEqual([accents.id]);
    expect((await find(bob, 'Résumé')).items.map((x) => x.id)).toEqual([accents.id]);
    expect((await find(bob, '"quick brown"')).items.map((x) => x.id)).toEqual([quick.id]);
    expect((await find(bob, 'quick brown')).items.map((x) => x.id).sort()).toEqual([quick.id, swapped.id].sort());
    // a phrase with stop words: its kept words side by side, then the exact words on the opened text
    expect((await find(bob, '"state of the art"')).items.map((x) => x.id)).toEqual([art.id]);
    expect((await find(bob, 'state art')).items.map((x) => x.id).sort()).toEqual([art.id, reversed.id].sort());
    // prefixes: up to four characters through the prefix table, the rest on the opened text
    expect((await find(bob, 'marm*')).items.map((x) => x.id)).toEqual([marm.id]);
    expect((await find(bob, 'marmala*')).items.map((x) => x.id)).toEqual([marm.id]);
    expect((await find(bob, 'marmo*')).items).toEqual([]);
    const sug = (await bob.get('/api/search/suggest?q=marm').expect(200)).body as { groups: { source: string; items: { id: string }[] }[]; completions: string[] };
    expect(sug.groups.find((x) => x.source === 'chats')!.items.map((x) => x.id)).toEqual([marm.id]);
    expect(sug.completions).toContain('marmalade');
    // the snippet marks the matched word
    const hit = (await find(bob, 'toast')).items[0]!;
    expect(hit.snippet.slice(hit.highlights[0]![0], hit.highlights[0]![1])).toBe('toast');
  });

  it('keeps the index current through edits, deletes, post and comment changes', async () => {
    await enableIndex(h);
    const g = await group();
    const m = await say(alice, g.id, 'alpha bravo');
    await settle(h);
    expect((await find(bob, 'bravo')).items.map((x) => x.id)).toEqual([m.id]);
    await alice.patch(`/api/messaging/messages/${m.id}`, { body: 'charlie delta' }).expect(200);
    await settle(h);
    expect((await find(bob, 'bravo')).items).toEqual([]);
    expect((await find(bob, 'charlie')).items.map((x) => x.id)).toEqual([m.id]);
    await alice.del(`/api/messaging/messages/${m.id}`).expect(200);
    await settle(h);
    expect((await find(bob, 'charlie')).items).toEqual([]);
    expect(await count(h, 'search_postings', { doc_kind: 'message', doc_id: m.id })).toBe(0);
    expect(await count(h, 'search_docs', { doc_kind: 'message', doc_id: m.id })).toBe(0);

    const post = (await alice.post('/api/feed/posts', { workspaceId: ws, body: 'echo foxtrot' }).expect(201)).body as { id: string };
    const comment = (await bob.post(`/api/feed/posts/${post.id}/comments`, { body: 'golf hotel' }).expect(201)).body as { id: string };
    await settle(h);
    await alice.patch(`/api/feed/posts/${post.id}`, { body: 'india juliet' }).expect(200);
    await settle(h);
    const pf = async (q: string) => ((await bob.get(`/api/search/posts?q=${q}`).expect(200)).body as { items: { id: string }[] }).items.map((x) => x.id);
    expect(await pf('foxtrot')).toEqual([]);
    expect(await pf('juliet')).toEqual([post.id]);
    expect(await pf('hotel')).toEqual([comment.id]);
    await bob.del(`/api/feed/comments/${comment.id}`).expect(200);
    await settle(h);
    expect(await pf('hotel')).toEqual([]);
    // an unlisted post leaves everyone's results but its author's, and its comments go with it
    const c2 = (await bob.post(`/api/feed/posts/${post.id}/comments`, { body: 'kilo lima' }).expect(201)).body as { id: string };
    await settle(h);
    expect(await pf('lima')).toEqual([c2.id]);
    await alice.patch(`/api/feed/posts/${post.id}`, { visibility: 'unlisted' }).expect(200);
    await settle(h);
    expect(await pf('juliet')).toEqual([]);
    expect(await pf('lima')).toEqual([]);
    expect(((await alice.get('/api/search/posts?q=juliet').expect(200)).body as { items: { id: string }[] }).items.map((x) => x.id)).toEqual([post.id]);
    await alice.del(`/api/feed/posts/${post.id}`).expect(200);
    await settle(h);
    expect(await count(h, 'search_docs', { doc_kind: 'post', doc_id: post.id })).toBe(0);
    // a deleted conversation takes its messages out of the index
    const m2 = await say(alice, g.id, 'mike november');
    await settle(h);
    expect(await count(h, 'search_docs', { doc_kind: 'message', doc_id: m2.id })).toBe(1);
    await alice.del(`${C}/${g.id}`).expect(200);
    await settle(h);
    expect(await count(h, 'search_docs', { doc_kind: 'message', doc_id: m2.id })).toBe(0);
  });

  it('indexes nothing while off and searches as before; the backfill resumes from its cursor', async () => {
    const g = await group();
    const ids: string[] = [];
    for (let i = 0; i < 45; i++) ids.push((await say(alice, g.id, `report number ${i} about the sierra project`)).id);
    await settle(h);
    expect(await count(h, 'search_postings')).toBe(0);
    // today's search across the reader's conversations (the per-conversation keyed terms)
    const before = await find(bob, 'sierra');
    expect(before.engine).toBe('fallback');
    expect(before.total).toBe(45);

    const admin = await adminPrincipal(h);
    // small batches so that one step is part of the work
    const st = await h.s.search.index.enable({ p: admin, ip: null });
    expect(st).toMatchObject({ enabled: true, state: 'building', activeVersion: null, buildingVersion: 1, progress: { processed: 0, total: 45 } });
    const version = st.buildingVersion!;
    // writes while building go to the version being built
    const during = await say(alice, g.id, 'tango arrives while building');
    await h.s.search.index.drain();
    expect(await count(h, 'search_docs', { doc_kind: 'message', doc_id: during.id })).toBe(1);
    // queries keep the old way until the backfill is done
    expect((await find(bob, 'sierra')).engine).toBe('fallback');

    const first = await h.s.search.index.backfillStep(h.tenantId, version, { maxBatches: 1 });
    expect(first.done).toBe(false);
    const st1 = (await h.s.search.index.state(h.tenantId))!;
    expect(JSON.parse(st1.cursor!)).toMatchObject({ kind: 'message' });
    const afterFirst = await count(h, 'search_docs', { tenant_id: h.tenantId });
    expect(afterFirst).toBe(46);
    // the job picks up where the step stopped: nothing is written twice
    await settle(h);
    const ready = await h.s.search.index.status(h.tenantId);
    expect(ready).toMatchObject({ state: 'ready', activeVersion: version, buildingVersion: null, documents: 46 });
    const one = ids[3]!;
    expect(await count(h, 'search_postings', { doc_kind: 'message', doc_id: one })).toBe(terms('report number 3 about the sierra project').length);
    const after = await find(bob, 'sierra');
    expect(after.engine).toBe('index');
    expect(after.total).toBe(45);
    expect((await h.s.db('audit_events').where({ tenant_id: h.tenantId }).whereIn('action', ['search.index.enabled', 'search.index.ready']).select('action')).map((r: { action: string }) => r.action).sort()).toEqual(['search.index.enabled', 'search.index.ready']);
  });

  it('a rotation indexes everything under a new key, then drops the old key and its postings', async () => {
    const g = await group();
    const m = await say(alice, g.id, 'uniform victor whiskey');
    await enableIndex(h);
    const v1 = (await h.s.db('search_postings').where({ doc_id: m.id, key_version: 1 }).orderBy('pos').select('term')).map((r: { term: string }) => r.term);
    expect(v1).toHaveLength(3);
    const admin = await adminPrincipal(h, 'rotator');
    const st = await h.s.search.index.rotate({ p: admin, ip: null });
    expect(st).toMatchObject({ state: 'ready', activeVersion: 1, buildingVersion: 2 });
    // while rotating, queries use version 1 and a new message is written under both
    const m2 = await say(alice, g.id, 'xray yankee');
    await h.s.search.index.drain();
    expect(await count(h, 'search_postings', { doc_id: m2.id, key_version: 1 })).toBe(2);
    expect(await count(h, 'search_postings', { doc_id: m2.id, key_version: 2 })).toBe(2);
    expect((await find(bob, 'whiskey')).items.map((x) => x.id)).toEqual([m.id]);
    await settle(h);
    expect(await h.s.search.index.status(h.tenantId)).toMatchObject({ state: 'ready', activeVersion: 2, buildingVersion: null });
    expect(await count(h, 'search_postings', { key_version: 1 })).toBe(0);
    expect(await count(h, 'search_prefixes', { key_version: 1 })).toBe(0);
    expect((await h.s.search.index.keys.versions(h.tenantId)).map((k) => k.version)).toEqual([2]);
    const v2 = (await h.s.db('search_postings').where({ doc_id: m.id, key_version: 2 }).orderBy('pos').select('term')).map((r: { term: string }) => r.term);
    expect(v2).toHaveLength(3);
    for (const t of v2) expect(v1).not.toContain(t);
    expect((await find(bob, 'whiskey')).items.map((x) => x.id)).toEqual([m.id]);
    expect((await find(bob, 'yankee')).items.map((x) => x.id)).toEqual([m2.id]);
    expect(await count(h, 'audit_events', { action: 'search.key.rotated' })).toBe(1);
  });

  it('the admin routes: tenant:manage only, audited, and disable removes everything', async () => {
    // members may not touch the index
    await alice.get('/api/admin/search').expect(403);
    await alice.post('/api/admin/search/enable', {}).expect(403);
    const admin = await adminPrincipal(h, 'tenantboss');
    const out = await h.s.search.index.enable({ p: admin, ip: null });
    expect(out.keys).toEqual([expect.objectContaining({ version: 1, state: 'building' })]);
    await expect(h.s.search.index.enable({ p: admin, ip: null })).rejects.toMatchObject({ status: 409 });
    await settle(h);
    const resumed = await h.s.search.index.rebuild({ p: admin, ip: null });
    expect(resumed).toMatchObject({ activeVersion: 1, buildingVersion: 2 });
    await settle(h);
    await h.s.search.index.disable({ p: admin, ip: null });
    for (const t of ['search_postings', 'search_prefixes', 'search_docs', 'search_keys', 'search_state']) expect(await count(h, t, { tenant_id: h.tenantId })).toBe(0);
    for (const a of ['search.index.enabled', 'search.index.rebuilt', 'search.index.disabled']) expect(await count(h, 'audit_events', { action: a })).toBe(1);
    // no query is audited
    await find(bob, 'anything');
    expect(await count(h, 'audit_events', { tenant_id: h.tenantId, action: 'search.query' })).toBe(0);
  });
});

describe('without migrations 138 and 139', () => {
  let h: Harness;
  afterEach(async () => {
    await h.close();
  });

  it('writes go on, search answers as before, and the index reports itself not installed', async () => {
    h = await harness();
    // stand in for a build that has not had them, also once they are registered
    if (await h.s.db.schema.hasTable('search_state')) await (await import('../src/db/migrations/139_search_state.js')).down(h.s.db);
    if (await h.s.db.schema.hasTable('search_postings')) await (await import('../src/db/migrations/138_search_index.js')).down(h.s.db);
    h.s.search.index.resetSchemaCache();
    const ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Design', 'confidential')).id;
    const alice = await person(h, 'alice', [ws]);
    const bob = await person(h, 'bob', [ws]);
    const g = (await alice.post(C, { kind: 'group', workspaceId: ws, memberIds: [bob.user.id] }).expect(201)).body as { id: string };
    const m = (await alice.post(`${C}/${g.id}/messages`, { body: 'papa quebec' }).expect(201)).body as { id: string };
    await alice.post('/api/feed/posts', { workspaceId: ws, body: 'romeo sierra' }).expect(201);
    await settle(h);
    const r = (await bob.get('/api/search/messages?q=quebec').expect(200)).body as { items: { id: string }[]; engine: string };
    expect(r).toMatchObject({ engine: 'fallback' });
    expect(r.items.map((x) => x.id)).toEqual([m.id]);
    expect(((await bob.get('/api/search/posts?q=romeo').expect(200)).body as { items: unknown[]; engine: string }).items).toHaveLength(1);
    expect(await h.s.search.index.status(h.tenantId)).toMatchObject({ installed: false, enabled: false });
    await expect(h.s.search.index.enable({ p: await adminPrincipal(h), ip: null })).rejects.toMatchObject({ status: 503 });
    // applying them later needs no restart
    await applySearchMigrations(h);
    expect(await h.s.search.index.status(h.tenantId)).toMatchObject({ installed: true, enabled: false });
  });
});

describe('performance', () => {
  let h: Harness;
  afterEach(async () => {
    await h.close();
  });

  it('100,000 messages indexed by the backfill; a query answers in under 50 ms', async () => {
    h = await searchHarness();
    const ws = (await h.s.tenants.createWorkspace(h.tenantId, 'Load', 'confidential')).id;
    const alice = await person(h, 'alice', [ws]);
    const bob = await person(h, 'bob', [ws]);
    const g = (await alice.post(C, { kind: 'group', workspaceId: ws, memberIds: [bob.user.id] }).expect(201)).body as { id: string };
    // A vocabulary of 4,000 made-up words; each message is eight of them (a seeded generator, so it is the same each run).
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const syl = ['ka', 'lo', 'mi', 'ne', 'ru', 'so', 'ta', 'vi', 'ze', 'po', 'qua', 'del', 'fin', 'gor', 'hul', 'jem'];
    const vocab = Array.from({ length: 4000 }, (_, i) => syl[i % 16]! + syl[Math.floor(i / 16) % 16]! + syl[Math.floor(i / 256) % 16]! + 'x');
    const N = 100_000;
    const t0 = Date.now();
    const rows: Record<string, unknown>[] = [];
    let sample = '';
    for (let i = 0; i < N; i++) {
      const id = ulid();
      const text = Array.from({ length: 8 }, () => vocab[Math.floor(rnd() * vocab.length)]!).join(' ');
      if (i === 777) sample = text;
      const at = t0 - (N - i) * 1000;
      rows.push({ id, tenant_id: h.tenantId, conversation_id: g.id, author_id: i % 2 ? alice.user.id : bob.user.id, body: await h.s.keys.seal(h.tenantId, text, `dm-message:${id}`), reply_to_id: null, thread_id: null, reply_count: 0, forwarded_from: null, attachments: null, label: 'internal', state: 'sent', edits: 0, edited_at: null, pinned_at: null, pinned_by: null, created_at: at, updated_at: at });
      if (rows.length === 500) await h.s.db('dm_messages').insert(rows.splice(0));
    }
    if (rows.length) await h.s.db('dm_messages').insert(rows.splice(0));
    // bob joined before all of it
    await h.s.db('dm_members').where({ conversation_id: g.id }).update({ visible_from: 0 });
    await enableIndex(h);
    expect(await h.s.search.index.status(h.tenantId)).toMatchObject({ state: 'ready', documents: N });
    const p = await bob.principal();
    const time = async (q: string) => {
      const runs: number[] = [];
      let total = 0;
      for (let i = 0; i < 7; i++) {
        const t = performance.now();
        total = (await h.s.search.chats.search(p, { q, limit: 20, mode: 'keyword' })).total;
        runs.push(performance.now() - t);
      }
      runs.sort((a, b) => a - b);
      return { median: runs[3]!, total };
    };
    const one = await time(vocab[1234]!);
    expect(one.total).toBeGreaterThan(50);
    expect(one.median).toBeLessThan(50);
    const [w1, , , w4] = sample.split(' ');
    const two = await time(`${w1} ${w4}`);
    expect(two.total).toBeGreaterThanOrEqual(1);
    expect(two.median).toBeLessThan(50);
    const prefix = await time(`${vocab[99]!.slice(0, 4)}*`);
    expect(prefix.median).toBeLessThan(50);
    if (process.env.SEARCH_PERF_LOG) process.stdout.write(`index ${Date.now() - t0} ms; one word ${one.median.toFixed(1)} ms (${one.total}), two words ${two.median.toFixed(1)} ms (${two.total}), prefix ${prefix.median.toFixed(1)} ms (${prefix.total})\n`);
  }, 600_000);
});
