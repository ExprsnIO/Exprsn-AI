import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CompiledTerms, hostsIn, joined, normalise, type TermEntry } from '../src/guardrails/term-match.js';
import { checkEntries, entriesFromCsv, MAX_TERM_ENTRIES } from '../src/guardrails/terms.js';
import { harness, localUser, login, loginAdmin, type Client, type Harness } from './helpers.js';

const words = (...xs: string[]): TermEntry[] => xs.map((value) => ({ value, match: 'word' }));

describe('B-156: term list normalisation and matching', () => {
  const deny = new CompiledTerms([...words('spam', 'free money', 'casino', 'kill'), { value: 'scam', match: 'substring' }, { value: 'evil.example', match: 'domain' }]);
  const found = (text: string) => deny.find(text).map((h) => h.entry);

  // Each tricky input must match its entry, and each plain one must not match anything.
  const TRICKY: [string, string, string][] = [
    ['case folding', 'Buy SPAM today', 'spam'],
    ['accents', 'Visit the cäsíno tonight', 'casino'],
    ['full-width letters', 'ｓｐａｍ for you', 'spam'],
    ['leetspeak 4 3 0 1 $ @', 'win at the c4$1n0', 'casino'],
    ['leetspeak @ and 0', 'fr33 m0n3y now', 'free money'],
    ['1 for l', 'ki11 it', 'kill'],
    ['Cyrillic lookalikes', 'а sрам message', 'spam'],
    ['Greek lookalikes', 'cαsinο night', 'casino'],
    ['zero-width characters', 'sp​am and s‍pam', 'spam'],
    ['soft hyphen', 'sp­am', 'spam'],
    ['letters split by spaces', 'this is s p a m ok', 'spam'],
    ['letters split by dots', 'this is s.p.a.m ok', 'spam'],
    ['letters split by hyphens', 'try c-a-s-i-n-o', 'casino'],
    ['phrase with extra spaces', 'FREE    money', 'free money'],
    ['phrase across a line break', 'free\nmoney', 'free money'],
    ['substring inside a word', 'a scammer wrote', 'scam'],
    ['domain', 'see https://evil.example/x', 'evil.example'],
    ['subdomain', 'mail from login.evil.example today', 'evil.example'],
    ['domain with lookalike letters', 'go to еvil.example', 'evil.example']
  ];
  const PLAIN = [
    'The spammer was caught', // word boundary: spammer is not spam
    'A casinos list', // plural is another word
    'Free shipping and money back',
    'Skills and killjoys', // kill inside a word
    'The class assessed the essay',
    'notevil.example.org is fine', // another domain
    'evil.examples.net is fine',
    's p a', // too short to be a word
    'I have 1 apple and 3 pears'
  ];

  it.each(TRICKY)('matches %s', (_what, text, entry) => {
    expect(found(text)).toContain(entry);
  });
  it.each(PLAIN.map((x) => [x]))('leaves the plain %s alone', (text) => {
    expect(found(text)).toEqual([]);
  });

  it('reports spans in the original text, for redaction', () => {
    const t = 'Hello ｓｐａｍ and s.p.a.m!';
    const hits = deny.find(t);
    expect(hits.map((h) => t.slice(h.span[0], h.span[1]))).toEqual(['ｓｐａｍ', 's.p.a.m']);
    const z = 'x sp​am y';
    const [h] = deny.find(z);
    expect(z.slice(h!.span[0], h!.span[1])).toBe('sp​am');
  });

  it('normalises with a character map, and joins split letters in a second reading only', () => {
    const r = normalise('Ａ  Café');
    expect(r.text).toBe('a cafe');
    expect(r.from).toHaveLength(r.text.length);
    expect(joined(normalise('plain words only'))).toBeNull();
    expect(joined(normalise('go s p a m now'))!.text).toBe('go spam now');
    expect(hostsIn('mail me at bob@corp.example or https://a.b.example/c').map((h) => h.host)).toEqual(['corp.example', 'a.b.example']);
  });

  it('checks entries: duplicates after normalisation, invalid domains and matches', () => {
    const r = checkEntries([{ value: 'Spam' }, { value: 'SP4M' }, { value: 'spam', match: 'substring' }, { value: 'not a domain', match: 'domain' }, { value: '*.Example.COM', match: 'domain' }, { value: 'x', match: 'regex' }, { value: '' }]);
    expect(r.entries).toEqual([{ value: 'Spam', match: 'word' }, { value: 'spam', match: 'substring' }, { value: 'example.com', match: 'domain' }]);
    expect(r.duplicates).toEqual([{ row: 2, value: 'SP4M', match: 'word', firstRow: 1 }]);
    expect(r.invalid.map((x) => x.row)).toEqual([4, 6, 7]);
    expect(entriesFromCsv('value,match\r\nspam,word\r\n"free, money",substring\r\n')).toEqual([{ value: 'spam', match: 'word' }, { value: 'free, money', match: 'substring' }]);
    expect(entriesFromCsv('spam\neggs\n')).toEqual([{ value: 'spam' }, { value: 'eggs' }]);
  });

  it('matches a 50,000-entry list against a 10 kB text in under 20 ms', () => {
    const entries: TermEntry[] = [];
    for (let i = 0; i < MAX_TERM_ENTRIES; i++) entries.push({ value: `zq${i.toString(36)}x${(i * 7919).toString(36)}`, match: i % 5 === 0 ? 'substring' : 'word' });
    entries[49_999] = { value: 'needle phrase', match: 'word' };
    const big = new CompiledTerms(entries);
    const sentence = 'The quarterly figures came in under budget, and the team shipped the release on time. ';
    let text = '';
    while (text.length < 10_000) text += sentence;
    text = text.slice(0, 9_980) + ' needle  phrase';
    big.find(text); // warm up the JIT
    const times: number[] = [];
    for (let i = 0; i < 7; i++) {
      const t0 = performance.now();
      const hits = big.find(text);
      times.push(performance.now() - t0);
      expect(hits.map((h) => h.entry)).toEqual(['needle phrase']);
    }
    times.sort((a, b) => a - b);
    expect(times[3]!).toBeLessThan(20);
  });
});

describe('B-156: term lists through the API, and the term-list mechanism', () => {
  let h: Harness;
  let admin: Client;
  const post = (url: string, body: object = {}) => admin.agent.post(url).set('x-csrf-token', admin.csrf).send(body);
  const put = (url: string, body: object) => admin.agent.put(url).set('x-csrf-token', admin.csrf).send(body);
  const csv = (url: string, text: string) => admin.agent.post(url).set('x-csrf-token', admin.csrf).set('content-type', 'text/csv').send(text);
  const check = (text: string) => h.s.guardrails.check({ tenantId: h.tenantId, workspaceId: null, checkpoint: 'user-input', text, label: 'internal' });

  beforeEach(async () => {
    h = await harness();
    await localUser(h, 'ga', ['guardrail-admin', 'member'], 'confidential');
    admin = await loginAdmin(h, 'ga');
  });
  afterEach(async () => h.close());

  const newList = async (name = 'spam-words', kind: 'deny' | 'allow' = 'deny', entries: object[] = [{ value: 'spam' }, { value: 'casino' }]) => (await post('/api/admin/guardrails/term-lists', { name, kind, entries }).expect(201)).body as { id: string; latestVersion: number };
  const ruleWith = (id: string, mechanism: object, action = 'block') => ({ id, name: id, checkpoint: 'user-input', type: 'term list', mechanism, action, stage: 'enforce', onError: 'closed', severity: 'medium', enabled: true });
  const publishSet = async (rules: object[]) => {
    const set = (await post('/api/admin/guardrails/sets', { name: `Set ${Math.random().toString(36).slice(2, 7)}`, scope: 'tenant' }).expect(201)).body as { id: string };
    await put(`/api/admin/guardrails/sets/${set.id}/draft`, { rules }).expect(200);
    await post(`/api/admin/guardrails/sets/${set.id}/draft/publish`).expect(200);
    return set;
  };

  it('blocks through a rule on the latest version, keeps a pinned rule on its version, and redacts the original span', async () => {
    const list = await newList();
    await publishSet([ruleWith('spam-latest', { kind: 'term-list', list: list.id, version: 'latest' })]);
    expect((await check('Win at the c4s1n0')).action).toBe('block');
    expect((await check('A quiet note')).action).toBe('allow');
    const pinned = await publishSet([ruleWith('spam-v1', { kind: 'term-list', list: list.id, version: 1 }, 'redact')]);
    // version 2 drops casino and adds lottery
    const v2 = (await put(`/api/admin/guardrails/term-lists/${list.id}/entries`, { entries: [{ value: 'spam' }, { value: 'lottery' }], note: 'v2' }).expect(200)).body;
    expect(v2).toMatchObject({ version: 2, entries: 2 });
    h.s.bus.publish('guardrails.terms.changed', { listId: null });
    // the pinned rule still sees casino (and redacts it in place); the latest rule sees lottery and no longer casino
    const casino = await check('try the casino');
    expect(casino.findings.map((f) => f.ruleId)).toEqual(['spam-v1']);
    expect(casino.action).toBe('redact');
    expect(casino.text).toBe('try the [redacted]');
    const lottery = await check('the l0ttery');
    expect(lottery.findings.map((f) => f.ruleId)).toEqual(['spam-latest']);
    expect(lottery.action).toBe('block');
    // one list, used by both rules
    const view = (await admin.agent.get(`/api/admin/guardrails/term-lists/${list.id}`).expect(200)).body;
    expect(view.usedBy.map((u: { ruleId: string }) => u.ruleId).sort()).toEqual(['spam-latest', 'spam-v1']);
    expect(view.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    // a list in use cannot be deleted
    const del = await admin.agent.delete(`/api/admin/guardrails/term-lists/${list.id}`).set('x-csrf-token', admin.csrf).expect(409);
    expect(del.body.usedBy).toHaveLength(2);
    expect(pinned.id).toBeTruthy();
    // audited
    const actions = (await h.s.db('audit_events').where('action', 'like', 'guardrail.terms.%').select('action')).map((x: { action: string }) => x.action);
    expect(actions).toEqual(expect.arrayContaining(['guardrail.terms.created', 'guardrail.terms.versioned']));
  });

  it('refuses rules that name a list or version the tenant does not have', async () => {
    const list = await newList();
    const set = (await post('/api/admin/guardrails/sets', { name: 'Refs', scope: 'tenant' }).expect(201)).body;
    const bad = await put(`/api/admin/guardrails/sets/${set.id}/draft`, { rules: [ruleWith('x', { kind: 'term-list', list: '01ARZ3NDEKTSV4RRFFQ69G5FAV', version: 'latest' })] }).expect(422);
    expect(bad.body.detail).toMatch(/does not exist/);
    const v9 = await put(`/api/admin/guardrails/sets/${set.id}/draft`, { rules: [ruleWith('x', { kind: 'term-list', list: list.id, version: 9 })] }).expect(422);
    expect(v9.body.detail).toMatch(/no version 9/);
  });

  it('matches domains and subdomains, and an allow list triggers on hosts outside it', async () => {
    const deny = await newList('bad-hosts', 'deny', [{ value: 'evil.example', match: 'domain' }]);
    const allow = await newList('our-hosts', 'allow', [{ value: 'corp.example', match: 'domain' }]);
    await publishSet([ruleWith('bad-hosts', { kind: 'term-list', list: deny.id, version: 'latest' }), ruleWith('only-ours', { kind: 'term-list', list: allow.id, version: 'latest' }, 'flag')]);
    const d1 = await check('see https://login.evil.example/x');
    expect(d1.findings.map((f) => f.ruleId).sort()).toEqual(['bad-hosts', 'only-ours']);
    const d2 = await check('see https://wiki.corp.example/page');
    expect(d2.action).toBe('allow');
    const d3 = await check('see https://evil.example.org/');
    expect(d3.findings.map((f) => f.ruleId)).toEqual(['only-ours']);
    // the live test of a list
    const t = (await post(`/api/admin/guardrails/term-lists/${deny.id}/test`, { text: 'x.evil.example and evil.example' }).expect(200)).body;
    expect(t.hits.map((x: { text: string }) => x.text)).toEqual(['x.evil.example', 'evil.example']);
  });

  it('imports CSV with a dry run that reports duplicates and invalid rows, and exports CSV', async () => {
    const list = await newList('imported', 'deny', [{ value: 'spam' }]);
    const body = 'value,match\r\nSPAM,word\r\nfree money,word\r\nfr33 m0ney,word\r\nbad host,domain\r\nshady.example,domain\r\nx,regex\r\n';
    const dry = (await csv(`/api/admin/guardrails/term-lists/${list.id}/import?dryRun=true&mode=append`, body).expect(200)).body;
    expect(dry).toMatchObject({ dryRun: true, mode: 'append', rows: 6, entries: 3, added: 2, duplicateCount: 2, invalidCount: 2, overLimit: false });
    expect(dry.duplicates.map((d: { value: string }) => d.value)).toEqual(['SPAM', 'fr33 m0ney']);
    expect(dry.invalid.map((d: { value: string }) => d.value)).toEqual(['bad host', 'x']);
    // nothing written by a dry run
    expect((await admin.agent.get(`/api/admin/guardrails/term-lists/${list.id}`).expect(200)).body.latestVersion).toBe(1);
    // an import with invalid rows is refused; a clean one is the next version
    await csv(`/api/admin/guardrails/term-lists/${list.id}/import?mode=append`, body).expect(422);
    const ok = (await csv(`/api/admin/guardrails/term-lists/${list.id}/import?mode=append`, 'value,match\nfree money,word\nshady.example,domain\nspam,word\n').expect(201)).body;
    expect(ok).toMatchObject({ version: 2, entries: 3, duplicateCount: 1 });
    const out = await admin.agent.get(`/api/admin/guardrails/term-lists/${list.id}/export`).expect(200);
    expect(out.headers['content-type']).toMatch(/text\/csv/);
    expect(out.text).toBe('value,match\r\nspam,word\r\nfree money,word\r\nshady.example,domain\r\n');
    const v1 = await admin.agent.get(`/api/admin/guardrails/term-lists/${list.id}/export?version=1`).expect(200);
    expect(v1.text).toBe('value,match\r\nspam,word\r\n');
    expect(await h.s.db('audit_events').where({ action: 'guardrail.terms.imported' })).toHaveLength(1);
    expect(await h.s.db('audit_events').where({ action: 'guardrail.terms.exported' })).toHaveLength(2);
  });

  it('caps a list at 50,000 entries', async () => {
    const list = await newList('big', 'deny', []);
    const rows = ['value'];
    for (let i = 0; i <= MAX_TERM_ENTRIES; i++) rows.push(`w${i}`);
    const dry = (await csv(`/api/admin/guardrails/term-lists/${list.id}/import?dryRun=true`, rows.join('\n')).expect(200)).body;
    expect(dry).toMatchObject({ entries: MAX_TERM_ENTRIES + 1, overLimit: true });
    const refused = await csv(`/api/admin/guardrails/term-lists/${list.id}/import`, rows.join('\n')).expect(422);
    expect(refused.body).toMatchObject({ title: 'Too many entries', max: MAX_TERM_ENTRIES, count: MAX_TERM_ENTRIES + 1 });
    const fits = await csv(`/api/admin/guardrails/term-lists/${list.id}/import`, rows.slice(0, -1).join('\n')).expect(201);
    expect(fits.body.entries).toBe(MAX_TERM_ENTRIES);
  }, 60_000);

  it('needs guardrails:manage, and keeps lists to their tenant', async () => {
    await localUser(h, 'mem', ['member']);
    const member = await login(h, 'mem');
    await member.agent.get('/api/admin/guardrails/term-lists').expect(403);
    const list = await newList();
    await expect(h.s.guard.terms.get('01ARZ3NDEKTSV4RRFFQ69G5FAX', list.id)).rejects.toMatchObject({ status: 404 });
    await expect(h.s.guard.terms.matcher('01ARZ3NDEKTSV4RRFFQ69G5FAX', { list: list.id, version: 'latest' })).rejects.toThrow(/does not exist/);
  });
});
