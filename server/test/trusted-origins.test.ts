import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { harness, localUser, PASSWORD, testConfig, type Harness } from './helpers.js';

describe('TRUSTED_ORIGINS', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await harness({ TRUSTED_ORIGINS: 'http://ai.example.local, https://192.0.2.10/ignored/path' });
    await localUser(h, 'origin-user', ['member']);
  });
  afterAll(async () => h.close());

  it('lists PUBLIC_URL first, then the trusted origins without paths', () => {
    expect(h.s.cfg.ORIGINS).toEqual(['http://localhost:8080', 'http://ai.example.local', 'https://192.0.2.10']);
    expect(h.s.cfg.ORIGIN).toBe('http://localhost:8080');
  });

  it('lets a sign-in from a trusted origin through and refuses any other', async () => {
    const body = { username: 'origin-user', password: PASSWORD };
    await request(h.app).post('/api/auth/login').set('Origin', 'http://ai.example.local').send(body).expect(200);
    await request(h.app).post('/api/auth/login').set('Origin', 'http://localhost:8080').send(body).expect(200);
    const refused = await request(h.app).post('/api/auth/login').set('Origin', 'http://evil.example').send(body);
    expect(refused.status).toBe(403);
  });

  it('refuses an entry that is not an http(s) origin', () => {
    expect(() => testConfig({ TRUSTED_ORIGINS: 'ftp://files.example' })).toThrow(/TRUSTED_ORIGINS/);
    expect(() => testConfig({ TRUSTED_ORIGINS: 'not a url' })).toThrow(/TRUSTED_ORIGINS/);
  });

  it('trusts only PUBLIC_URL when unset', () => {
    expect(testConfig().ORIGINS).toEqual(['http://localhost:8080']);
  });
});
