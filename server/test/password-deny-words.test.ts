import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { down as unmigrate131, up as migrate131 } from '../src/db/migrations/131_leaked_password_lists.js';
import { compileDenyWords, findDenyWord } from '../src/identity/deny-words.js';
import type { Actor } from '../src/identity/leaked/service.js';
import { harness, localUser, loginAdmin, type Harness } from './helpers.js';

/*
 * 1.9.0, Sprint 55 (B-194): tenant deny words, normalised like B-156's term lists (case, accents, leetspeak,
 * lookalike letters, spacing), per tenant. The migration is applied by hand (it is not registered yet).
 */

const found = (words: string[], password: string) => findDenyWord(compileDenyWords(words), words, password);

describe('deny-word matching', () => {
  const words = ['Acme', 'Springfield', 'Widget Pro'];

  it('folds case and accents', () => {
    expect(found(words, 'myACMEpassword1')).toBe('Acme');
    expect(found(words, 'ácmé-forever-2026')).toBe('Acme');
    expect(found(words, 'SPRİNGFİELD rules')).toBe('Springfield');
  });

  it('folds leetspeak and lookalike letters', () => {
    expect(found(words, '@CM3 is the best')).toBe('Acme');
    expect(found(words, '4cm3-4cm3-4cm3')).toBe('Acme');
    expect(found(words, 'Spr1ngf13ld!!')).toBe('Springfield');
    expect(found(words, 'Аcmе in Cyrillic')).toBe('Acme'); // Cyrillic А and е
    expect(found(words, 'ＡＣＭＥ full width')).toBe('Acme');
  });

  it('sees through spacing and separators, inside words and phrases', () => {
    expect(found(words, 'a c m e 1 2 3 4')).toBe('Acme');
    expect(found(words, 'a.c.m.e.secret.words')).toBe('Acme');
    expect(found(words, 'ac-me-is-my-employer')).toBe('Acme');
    expect(found(words, 'zzzacme​zzz')).toBe('Acme');
    expect(found(words, 'widgetpro forever')).toBe('Widget Pro');
    expect(found(words, 'my widget-pro password')).toBe('Widget Pro');
  });

  it('leaves passwords without the words alone, and ignores entries too short to mean anything', () => {
    expect(found(words, 'correct horse battery staple')).toBeNull();
    expect(found(['a', 'x1'], 'any password at all')).toBeNull();
    expect(compileDenyWords([])).toBeNull();
  });
});

describe('deny words per tenant', () => {
  let h: Harness;
  let otherId = '';
  const actor = (tenantId: string): Actor => ({ tenantId, userId: null, audit: { service: 'test' }, traceId: null, platform: false, identity: true });

  beforeAll(async () => {
    h = await harness();
    await unmigrate131(h.s.db);
    await migrate131(h.s.db);
    h.s.leakedPasswords.resetSchemaCache();
    otherId = (await h.s.tenants.create({ slug: 'other', name: 'Other' })).id;
  });
  afterAll(async () => {
    await h.close();
  });

  it('has none until the tenant saves some (today\'s behaviour)', async () => {
    expect(await h.s.passwordDenyWords.check(h.tenantId, 'acme acme acme')).toEqual({ found: false });
  });

  it('applies a tenant\'s words to that tenant only, through the password pipeline too', async () => {
    await h.s.leakedPasswords.saveSettings(actor(h.tenantId), { denyWords: ['Acme', 'Gotham'] });
    expect(await h.s.passwordDenyWords.check(h.tenantId, 'I work at 4CME corp')).toEqual({ found: true, term: 'Acme' });
    expect(await h.s.passwordDenyWords.check(otherId, 'I work at 4CME corp')).toEqual({ found: false });
    await h.s.leakedPasswords.saveSettings(actor(otherId), { denyWords: ['Metropolis'] });
    expect(await h.s.passwordDenyWords.check(otherId, 'metr0polis by night')).toEqual({ found: true, term: 'Metropolis' });
    expect(await h.s.passwordDenyWords.check(h.tenantId, 'metr0polis by night')).toEqual({ found: false });

    const err = await h.s.account.checkNewPassword({ tenantId: h.tenantId, username: 'someone', password: 'gotham city at night' }).catch((e: { status: number; detail: string; extensions?: Record<string, unknown> }) => e);
    expect(err).toMatchObject({ status: 400 });
    expect(JSON.stringify(err)).toContain('Gotham');
    await expect(h.s.account.checkNewPassword({ tenantId: otherId, username: 'someone', password: 'gotham city at night' })).resolves.toBeTruthy();
  });

  it('uses a guardrail term list as the tenant\'s words when one is named', async () => {
    const created = await h.s.guard.terms.create(h.tenantId, { name: 'brand-words', kind: 'deny' }, [{ value: 'Wayne Enterprises', match: 'word' }, { value: 'example.com', match: 'domain' }], 'test');
    await h.s.leakedPasswords.saveSettings(actor(h.tenantId), { denyTermList: created.list.id });
    expect(await h.s.passwordDenyWords.check(h.tenantId, 'w4yne-enterprises-99')).toEqual({ found: true, term: 'Wayne Enterprises' });
    expect(await h.s.passwordDenyWords.check(h.tenantId, 'I work at 4CME corp')).toEqual({ found: true, term: 'Acme' });
    await expect(h.s.leakedPasswords.saveSettings(actor(h.tenantId), { denyTermList: '01ARZ3NDEKTSV4RRFFQ69G5FAV' })).rejects.toMatchObject({ status: 404 });
  });

  it('is set through the route by an identity admin, and audited', async () => {
    await localUser(h, 'ida', ['identity-admin'], 'internal');
    const ida = await loginAdmin(h, 'ida');
    const res = await ida.agent.put('/api/admin/leaked-passwords/settings').set('x-csrf-token', ida.csrf).send({ denyWords: ['Smallville'], denyTermList: null });
    expect(res.status).toBe(200);
    expect(res.body.denyWords).toEqual(['Smallville']);
    expect(await h.s.passwordDenyWords.check(h.tenantId, 'sm4llv1lle!')).toEqual({ found: true, term: 'Smallville' });
    expect(await h.s.passwordDenyWords.check(h.tenantId, 'I work at 4CME corp')).toEqual({ found: false });
    const tooMany = await ida.agent.put('/api/admin/leaked-passwords/settings').set('x-csrf-token', ida.csrf).send({ denyWords: Array.from({ length: 201 }, (_, i) => `word${i}`) });
    expect(tooMany.status).toBe(400);
    const audit = await h.s.db('audit_events').where({ action: 'passwords.settings.updated' }).orderBy('seq', 'desc').first();
    expect(audit).toBeTruthy();
  });
});
