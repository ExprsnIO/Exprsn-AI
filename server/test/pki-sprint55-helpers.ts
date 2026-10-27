/*
 * 1.9.0, Sprint 55 (B-187 to B-189): what the CA settings, CA token and member certificate suites share. The signer
 * here is a real `exprsn-ai signer` process run in this test process on a temporary socket with a throwaway key, so
 * every CA key is made and used in custody, as in production, and nothing touches a live signer.
 */
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request, { type Test } from 'supertest';
import { down as down127, up as up127 } from '../src/db/migrations/127_pki_settings.js';
import { down as down128, up as up128 } from '../src/db/migrations/128_ca_tokens.js';
import { buildCsr } from '../src/ops/der.js';
import { int, nul, octets, oid, seq } from '../src/pki/asn1.js';
import { OCSP_OIDS } from '../src/pki/ocsp.js';
import { certificateParts, spkiKeyBits } from '../src/pki/x509.js';
import { startSigner } from '../src/signer/server.js';
import { localUser, loginAdmin, type Harness } from './helpers.js';

export async function signerFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'exs55-'));
  const socketPath = path.join(dir, 'run', 'signer.sock');
  const token = randomBytes(24).toString('base64url') + 'x'.repeat(8);
  const signer = await startSigner({ socketPath, key: randomBytes(32).toString('base64'), token });
  return {
    socketPath,
    token,
    signer,
    close: async () => {
      await signer.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/** Applies the sprint's migrations (registered by the owner later) and makes the services look again. */
export async function migrate55(h: Harness, which: { settings?: boolean; tokens?: boolean } = { settings: true, tokens: true }) {
  // The harness now runs 127 and 128 with every migration (registered 2026-10-18): start from before them.
  await down128(h.s.db);
  await down127(h.s.db);
  if (which.settings !== false) await up127(h.s.db);
  if (which.tokens !== false) await up128(h.s.db);
  h.s.pkiSettings.forget();
  h.s.caTokens.forget();
  h.s.memberCerts.forget();
}

export type AdminClient = Awaited<ReturnType<typeof admin>>;

export async function admin(h: Harness, username: string, roles: string[]) {
  await localUser(h, username, roles, 'confidential');
  const c = await loginAdmin(h, username);
  return {
    ...c,
    get: (p: string) => c.agent.get(p),
    post: (p: string, b: object = {}) => c.agent.post(p).set('x-csrf-token', c.csrf).send(b),
    put: (p: string, b: object = {}) => c.agent.put(p).set('x-csrf-token', c.csrf).send(b),
    patch: (p: string, b: object = {}) => c.agent.patch(p).set('x-csrf-token', c.csrf).send(b)
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const drain = async (h: Harness, rounds = 6) => {
  for (let i = 0; i < rounds; i++) {
    await h.s.jobs.runDue();
    await sleep(10);
  }
};

export const csrPem = (domains: string[]) => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const der = buildCsr(domains, privateKey);
  return `-----BEGIN CERTIFICATE REQUEST-----\n${der.toString('base64').replace(/.{1,64}/g, '$&\n')}-----END CERTIFICATE REQUEST-----\n`;
};

const derOfPem = (p: string) => Buffer.from(p.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');

/** An OCSP request for serials under one issuer certificate (SHA-1 CertIDs, no nonce). */
export function ocspRequest(issuerPem: string, serials: string[]): Buffer {
  const parts = certificateParts(derOfPem(issuerPem));
  const h = (b: Buffer) => createHash('sha1').update(b).digest();
  const ids = serials.map((s) => seq(seq(seq(oid(OCSP_OIDS.sha1), nul()), octets(h(parts.subject)), octets(h(spkiKeyBits(parts.spki))), int(Buffer.from(s, 'hex')))));
  return seq(seq(seq(...ids)));
}

/** SuperTest buffers only text and JSON by default; CRLs and OCSP answers are bytes. */
export const binary = (t: Test) =>
  t.buffer(true).parse((res, cb) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });

export const ocspPost = (h: Harness, body: Buffer) => binary(request(h.app).post('/pki/ocsp').set('content-type', 'application/ocsp-request')).send(body);

/** The services as they are without migrations 127 and 128: for the tests of what happens before they are applied. */
export async function unmigrate55(h: Harness) {
  await migrate55(h, { settings: false, tokens: false });
}
