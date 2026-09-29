import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config/index.js';
import { resolveSecret } from '../src/identity/secrets.js';

const base = { SESSION_SECRET: 'x'.repeat(64), DATA_KEY: Buffer.alloc(32, 1).toString('base64') };

describe('configuration', () => {
  it('refuses production without HTTPS cookies', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', PUBLIC_URL: 'http://ai.example.internal' })).toThrow(/COOKIE_SECURE/);
    expect(loadConfig({ ...base, NODE_ENV: 'production', PUBLIC_URL: 'https://ai.example.internal' }).COOKIE_SECURE).toBe(true);
  });

  it('requires strong secrets', () => {
    expect(() => loadConfig({ ...base, SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
    expect(() => loadConfig({ ...base, DATA_KEY: 'bm90MzJieXRlcw==' })).toThrow(/DATA_KEY/);
  });

  it('requires a URL for server databases', () => {
    expect(() => loadConfig({ ...base, DB_CLIENT: 'pg' })).toThrow(/DATABASE_URL/);
  });

  it('reads secrets from *_FILE for the known secret names only', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'exprsn-cfg-'));
    try {
      writeFileSync(path.join(dir, 's'), 'y'.repeat(64) + '\n');
      const cfg = loadConfig({ ...base, SESSION_SECRET_FILE: path.join(dir, 's'), UNRELATED_FILE: '/definitely/not/here' });
      expect(cfg.SESSION_SECRET).toBe('y'.repeat(64));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('derives the origin and WebAuthn relying party from PUBLIC_URL', () => {
    const cfg = loadConfig({ ...base, PUBLIC_URL: 'https://ai.example.internal:8443/' });
    expect(cfg.ORIGIN).toBe('https://ai.example.internal:8443');
    expect(cfg.WEBAUTHN_RP_ID).toBe('ai.example.internal');
  });
});

describe('secret references', () => {
  it('resolves env: and file: and rejects anything else', () => {
    expect(resolveSecret('env:X', { X: 'v' })).toBe('v');
    expect(() => resolveSecret('env:MISSING', {})).toThrow(/not set/);
    expect(() => resolveSecret('hunter2', {})).toThrow();
  });
});
