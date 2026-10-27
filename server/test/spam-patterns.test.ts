/*
 * 1.9.0, Sprint 50 (B-160): spam patterns. SimHash near-duplicates against unrelated texts, link bursts and newly
 * seen domains, mention and hashtag flooding, new-account velocity, a coordinated cluster of accounts posting the
 * same text, the score's decay, the detector leaf, and that nothing but hashes, domains and counts is stored.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setSpamScoreSource, spamScoreDetection, spamScoreFor } from '../src/guardrails/detectors.js';
import { MemoryCounterStore } from '../src/platform/ratelimit.js';
import { features, fingerprintOf, hamming, linkDomains, mentionCount, hashtagCount, parseFingerprint, simhash } from '../src/spam/patterns.js';
import { SpamService } from '../src/spam/service.js';
import type { Harness } from './helpers.js';
import { clock, person, spamHarness } from './spam-helpers.js';

const OFFER = 'Limited offer today only: buy cheap watches and designer bags at our online store, free shipping worldwide for every order this week';
const SIGNALS = 'Join my channel for daily crypto signals, we doubled our money last month and you can too, link in my profile';
const MEETING = 'Hi team, the quarterly planning meeting moves to Thursday at ten; please bring your notes on the roadmap and budget';

describe('SimHash', () => {
  it('keeps near-duplicates close and unrelated texts far apart', () => {
    const a = simhash(OFFER)!;
    for (const v of [OFFER.replace('today', 'now'), OFFER + '!!', OFFER.toUpperCase(), OFFER + ' https://shop.example/w']) expect(hamming(a, simhash(v)!)).toBeLessThanOrEqual(12);
    for (const other of [SIGNALS, MEETING]) expect(hamming(a, simhash(other)!)).toBeGreaterThan(20);
    expect(hamming(simhash(SIGNALS)!, simhash(MEETING)!)).toBeGreaterThan(20);
  });

  it('is stable, round-trips as hex, and says nothing of very short texts', () => {
    const a = simhash(OFFER)!;
    expect(simhash(OFFER)!.hex).toBe(a.hex);
    expect(a.hex).toMatch(/^[0-9a-f]{16}$/);
    expect(parseFingerprint(a.hex)).toEqual(a);
    expect(a.bands).toEqual(fingerprintOf(a.hi, a.lo).bands);
    expect(simhash('ok')).toBeNull();
    expect(hamming(fingerprintOf(0, 0), fingerprintOf(0xffffffff, 0x0000000f))).toBe(36);
  });

  it('counts links, domains, mentions and hashtags', () => {
    expect(linkDomains('see https://WWW.Example.com:8080/a?b and http://user@spam.example/x and www.other.example.org')).toEqual(['example.com', 'spam.example', 'other.example.org']);
    expect(mentionCount('@ann @bob hi (@cy) mail@example.com')).toBe(3);
    expect(hashtagCount('#one #two x#three (#four)')).toBe(3);
    const f = features('Buy now https://a.example https://a.example #deal @x')!;
    expect(f).toMatchObject({ links: 2, domains: ['a.example'], mentions: 1, hashtags: 1 });
  });
});

describe('spam patterns in the service', () => {
  let h: Harness;
  let admin: Awaited<ReturnType<typeof person>>;
  const c = clock();
  let svc: SpamService;
  const ev = (userId: string, text: string, recipient: string, surface: 'post' | 'message' | 'comment' = 'post') => svc.observe({ tenantId: h.tenantId, surface, userId, ip: '203.0.113.20', text, recipient, accountCreatedAt: 0 });

  beforeAll(async () => {
    h = await spamHarness();
    admin = await person(h, 'pat-admin', ['tenant-admin']);
    svc = new SpamService(() => h.s, { now: c.now, store: new MemoryCounterStore() });
    await svc.savePolicy(admin.p, { enabled: true, patterns: { duplicateRecipients: 4, linkBurst: 5, newDomains: 3, mentions: 6, hashtags: 6, clusterAccounts: 3, newAccountEvents: 5 } });
  });
  afterAll(async () => h.close());

  it('finds the same text sent to many recipients, not different texts', async () => {
    const u = await person(h, 'pat-dup');
    let last = null;
    for (let i = 0; i < 4; i++) last = await ev(u.id, i % 2 ? OFFER : OFFER.replace('today', 'right now'), `conv-${i}`, 'message');
    expect(last!.reasons.find((r) => r.signal === 'near_duplicate')).toMatchObject({ value: 4, threshold: 4 });
    const v = await person(h, 'pat-varied');
    let other = null;
    for (const [i, t] of [OFFER, SIGNALS, MEETING, 'Lunch is in the kitchen today, there are sandwiches and soup for everyone who stayed late'].entries()) other = await ev(v.id, t, `conv-v${i}`, 'message');
    expect(other!.reasons.some((r) => r.signal === 'near_duplicate')).toBe(false);
  });

  it('notices a burst of links and domains first seen in the tenant', async () => {
    const u = await person(h, 'pat-links');
    const o1 = await ev(u.id, 'Read this https://fresh-one.example/a and https://fresh-two.example/b now', 'ws-1');
    expect(o1!.reasons.some((r) => r.signal === 'new_domains')).toBe(false);
    const o2 = await ev(u.id, 'Also https://fresh-three.example/c then https://fresh-one.example/d and https://fresh-four.example/e', 'ws-1');
    expect(o2!.reasons.find((r) => r.signal === 'link_burst')).toMatchObject({ value: 5, threshold: 5 });
    expect(o2!.reasons.find((r) => r.signal === 'new_domains')!.value).toBeGreaterThanOrEqual(3);
    const rows = await h.s.db('spam_domains').where({ tenant_id: h.tenantId }).orderBy('domain');
    expect(rows.map((r) => r.domain)).toEqual(['fresh-four.example', 'fresh-one.example', 'fresh-three.example', 'fresh-two.example']);
    expect(rows.find((r) => r.domain === 'fresh-one.example')!.uses).toBe(2);
    // A domain seen long ago is not new: a day later the same links count as bursts, not new domains.
    c.add(25 * 3_600_000);
    const o3 = await ev(u.id, 'Old friends https://fresh-one.example/z https://fresh-two.example/y https://fresh-three.example/x https://fresh-four.example/w https://fresh-one.example/v', 'ws-1');
    expect(o3!.reasons.some((r) => r.signal === 'link_burst')).toBe(true);
    expect(o3!.reasons.some((r) => r.signal === 'new_domains')).toBe(false);
  });

  it('flags mention and hashtag flooding in one text', async () => {
    const u = await person(h, 'pat-mentions');
    const o = await ev(u.id, 'Hey @a @b @c @d @e @f @g look at #x #y #z #w #v #u #t', 'ws-1');
    expect(o!.reasons.find((r) => r.signal === 'mention_flood')).toMatchObject({ value: 7, threshold: 6 });
    expect(o!.reasons.find((r) => r.signal === 'hashtag_flood')).toMatchObject({ value: 7, threshold: 6 });
    const calm = await ev(u.id, 'Thanks @a and @b for the notes on #planning', 'ws-1');
    expect(calm!.signals.some((r) => r.signal === 'mention_flood' || r.signal === 'hashtag_flood')).toBe(false);
    // The score keeps the earlier reasons while it is higher than what this text showed.
    expect(calm!.reasons.some((r) => r.signal === 'mention_flood')).toBe(true);
  });

  it('weighs a new account writing fast, not an old one', async () => {
    const young = await person(h, 'pat-young');
    await h.s.db('users').where({ id: young.id }).update({ created_at: c.now() - 3_600_000 });
    const old = await person(h, 'pat-old');
    await h.s.db('users').where({ id: old.id }).update({ created_at: c.now() - 30 * 24 * 3_600_000 });
    let y = null;
    let o = null;
    for (let i = 0; i < 5; i++) {
      y = await svc.observe({ tenantId: h.tenantId, surface: 'follow', userId: young.id, recipient: `t${i}` });
      o = await svc.observe({ tenantId: h.tenantId, surface: 'follow', userId: old.id, recipient: `t${i}` });
    }
    expect(y!.reasons.find((r) => r.signal === 'new_account_velocity')).toMatchObject({ value: 5, threshold: 5 });
    expect(o!.reasons.some((r) => r.signal === 'new_account_velocity')).toBe(false);
  });

  it('finds a coordinated cluster of accounts posting the same thing', async () => {
    const text = 'Vote for the new parking rules at the town meeting, everyone should come and support the proposal on Monday evening';
    const users = [await person(h, 'pat-c1'), await person(h, 'pat-c2'), await person(h, 'pat-c3')];
    const out = [];
    for (const [i, u] of users.entries()) out.push(await ev(u.id, i === 1 ? text.replace('Monday', 'Tuesday') : text, `ws-c${i}`));
    expect(out[0]!.reasons.some((r) => r.signal === 'coordinated_cluster')).toBe(false);
    expect(out[2]!.reasons.find((r) => r.signal === 'coordinated_cluster')).toMatchObject({ value: 3, threshold: 3 });
  });

  it('scores 0 to 100 with reasons, and the score decays by its half-life', async () => {
    const u = await person(h, 'pat-decay');
    const o = await ev(u.id, 'Hey @a @b @c @d @e @f @g @h @i @j look at #x #y #z #w #v #u #t #s #r', 'ws-1');
    expect(o!.score).toBeGreaterThan(0);
    expect(o!.score).toBeLessThanOrEqual(100);
    const now = await svc.scoreOf(h.tenantId, u.id);
    expect(now!.score).toBe(o!.score);
    expect(now!.reasons.map((r) => r.signal).sort()).toEqual(['hashtag_flood', 'mention_flood']);
    c.add(360 * 60_000); // the default half-life of six hours
    expect((await svc.scoreOf(h.tenantId, u.id))!.score).toBe(Math.round(o!.score / 2));
    c.add(10 * 360 * 60_000);
    const gone = await svc.scoreOf(h.tenantId, u.id);
    expect(gone!.score).toBe(0);
    expect(gone!.reasons).toEqual([]);
    // A calm event after the decay keeps the decayed score, not the old one.
    const calm = await ev(u.id, 'Thanks for the notes, see you at the meeting', 'ws-1');
    expect(calm!.score).toBe(0);
  });

  it('offers the score to guardrail conditions through the detector leaf', async () => {
    const u = await person(h, 'pat-leaf');
    const o = await ev(u.id, 'Hey @a @b @c @d @e @f @g @h look', 'ws-1');
    setSpamScoreSource(async (t, id) => {
      const r = await svc.scoreOf(t, id);
      return r ? { score: r.score, reasons: r.reasons } : null;
    });
    try {
      expect((await spamScoreFor(h.tenantId, u.id))!.score).toBe(o!.score);
      expect(await spamScoreFor(h.tenantId, 'nobody')).toBeNull();
      setSpamScoreSource(() => new Promise(() => undefined));
      expect(await spamScoreFor(h.tenantId, u.id, 20)).toBeNull();
    } finally {
      setSpamScoreSource(null);
    }
    expect(spamScoreDetection(42)).toEqual({ kind: 'spam_score', span: [0, 0], score: 0.42 });
    expect(spamScoreDetection(0)).toBeNull();
  });

  it('stores hashes, domains and counts, never the text', async () => {
    const secret = 'Zanzibarquokka unicornsmoothie flamingoparade marmaladeorbit velvetcactus';
    const u = await person(h, 'pat-sealed');
    for (let i = 0; i < 3; i++) await ev(u.id, `${secret} @p${i} https://sealed-check.example/${i}`, `private-conversation-${i}`, 'message');
    const words = ['zanzibarquokka', 'unicornsmoothie', 'flamingoparade', 'marmaladeorbit', 'velvetcactus', 'private-conversation'];
    for (const table of ['spam_fingerprints', 'spam_domains', 'spam_scores', 'spam_policies', 'spam_responses']) {
      const dump = JSON.stringify(await h.s.db(table).select()).toLowerCase();
      for (const w of words) expect(dump, `${table} holds "${w}"`).not.toContain(w);
    }
    const fp = await h.s.db('spam_fingerprints').where({ account: u.id });
    expect(fp).toHaveLength(3);
    for (const r of fp) {
      expect(r.fingerprint).toMatch(/^[0-9a-f]{16}$/);
      expect(r.recipient).toMatch(/^[0-9a-f]{16}$/);
    }
  });
});
