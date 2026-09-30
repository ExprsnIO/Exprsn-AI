import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, SERVER_ENV_NAMES } from '../src/config/index.js';
import { resolveSecret, secretPolicy, secretRefProblem } from '../src/identity/secrets.js';

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
  const dir = mkdtempSync(path.join(tmpdir(), 'exprsn-secrets-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'exprsn-outside-'));
  writeFileSync(path.join(dir, 'ldap_pw'), 'bind-pw\n');
  writeFileSync(path.join(dir, 'data_key'), 'master-key');
  writeFileSync(path.join(outside, 'other'), 'not yours');
  symlinkSync(path.join(outside, 'other'), path.join(dir, 'escape'));
  const policy = secretPolicy({ envAllow: 'IDP_*,HR_DB', dirs: dir, serverEnvNames: SERVER_ENV_NAMES, serverSecretFiles: [path.join(dir, 'data_key')] });

  it('resolves allowed env: and file: references and rejects anything else', () => {
    expect(resolveSecret('env:IDP_LDAP_PW', { IDP_LDAP_PW: 'v' }, policy)).toBe('v');
    expect(resolveSecret('env:HR_DB', { HR_DB: 'x' }, policy)).toBe('x');
    expect(() => resolveSecret('env:IDP_MISSING', {}, policy)).toThrow(/not set/);
    expect(resolveSecret(`file:${path.join(dir, 'ldap_pw')}`, {}, policy)).toBe('bind-pw');
    expect(() => resolveSecret('hunter2', {}, policy)).toThrow();
  });

  it('refuses variables the operator has not listed, and the server\'s own settings even when a pattern matches', () => {
    expect(() => resolveSecret('env:HOME', { HOME: '/root' }, policy)).toThrow(/SECRET_REF_ENV/);
    const everything = secretPolicy({ envAllow: '*', dirs: '', serverEnvNames: SERVER_ENV_NAMES, serverSecretFiles: [] });
    for (const name of ['DATA_KEY', 'SESSION_SECRET', 'DATABASE_URL', 'DATA_KEY_FILE', 'SQLITE_FILENAME']) {
      expect(secretRefProblem(`env:${name}`, everything)).toMatch(/server's own settings/);
      expect(() => resolveSecret(`env:${name}`, { [name]: 'secret' }, everything)).toThrow(/not allowed/);
    }
  });

  it('confines file: references to the configured directories, following symlinks, and never reads the server\'s own secret files', () => {
    expect(secretRefProblem(`file:${path.join(outside, 'other')}`, policy)).toMatch(/SECRET_REF_DIRS/);
    expect(secretRefProblem(`file:${dir}/../${path.basename(outside)}/other`, policy)).toMatch(/SECRET_REF_DIRS/);
    expect(() => resolveSecret(`file:${path.join(dir, 'escape')}`, {}, policy)).toThrow(/outside the permitted directories/);
    expect(secretRefProblem(`file:${path.join(dir, 'data_key')}`, policy)).toMatch(/server's own secrets/);
    expect(() => resolveSecret('file:relative/path', {}, policy)).toThrow(/absolute/);
  });

  it('refuses every reference until the server configures a policy', () => {
    expect(secretRefProblem('env:IDP_X', secretPolicy({ envAllow: '', dirs: '', serverEnvNames: new Set(), serverSecretFiles: [] }))).toMatch(/SECRET_REF_ENV/);
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
});
