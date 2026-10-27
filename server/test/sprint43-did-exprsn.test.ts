import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { ulid } from 'ulid';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { didExprsnFromMultikey, isDidExprsn, selfCertifyingDocument } from '../src/atproto/did-exprsn.js';
import { DidResolver, labelerFromDocument, type GuardedFetch } from '../src/atproto/did.js';
import { readLabel, verifyLabel } from '../src/atproto/labels.js';
import { ServiceJwtVerifier } from '../src/atproto/service-jwt.js';
import { loadPrincipal } from '../src/http/middleware.js';
import { startSigner } from '../src/signer/server.js';
import { harness, localUser, login, type Harness } from './helpers.js';

/*
 * Sprint 43 (1.7.0), B-113: did:exprsn. The "done when" of each item is a test below:
 *   B-11301 a did:exprsn resolves offline to a document whose key verifies the account's signature, and no shared
 *           secret is read to derive it;
 *   B-11302 a user's did:exprsn names their PDS DID, and a label they signed verifies.
 * The interop vector (test/fixtures/atproto/did-exprsn.json) was made with exprsn-platform's own resolver and label
 * signer (services/atproto: didResolver.didExprsnFromKey, resolveDid, labeler/labelSigner.signLabel).
 */

const vector = JSON.parse(readFileSync(new URL('./fixtures/atproto/did-exprsn.json', import.meta.url), 'utf8')) as { did: string; publicKeyMultibase: string; label: Record<string, unknown>; sig: string };

/** A resolver that fails any network fetch: did:exprsn must not need one. */
const offline = () => new DidResolver({ request: async () => { throw new Error('no network in this test'); } } as unknown as GuardedFetch, () => 'https://plc.invalid');

describe('did:exprsn (offline)', () => {
  it('B-11301: the platform\'s did:exprsn resolves offline and its label verifies; a changed label does not', async () => {
    expect(isDidExprsn(vector.did)).toBe(true);
    expect(didExprsnFromMultikey(vector.publicKeyMultibase)).toBe(vector.did);
    const doc = await offline().resolve(vector.did);
    expect(doc).toMatchObject({ id: vector.did, verificationMethod: [expect.objectContaining({ id: `${vector.did}#atproto` }), expect.objectContaining({ id: `${vector.did}#atproto_label`, publicKeyMultibase: vector.publicKeyMultibase })] });
    const k = labelerFromDocument(doc, vector.did);
    const raw = { ...vector.label, sig: { $bytes: vector.sig.replace(/=+$/, '') } };
    expect(verifyLabel(raw, readLabel(raw)!, k.curve, k.key)).toBe(true);
    const tampered = { ...raw, val: 'spam' };
    expect(verifyLabel(tampered, readLabel(tampered)!, k.curve, k.key)).toBe(false);
    // did:key resolves the same way; something that is not a key does not resolve
    expect((await offline().resolve(`did:key:${vector.publicKeyMultibase}`)) as { id: string }).toMatchObject({ id: `did:key:${vector.publicKeyMultibase}` });
    await expect(offline().resolve('did:exprsn:z1111111111111111111111111111111111111111111')).rejects.toThrow();
    expect(() => selfCertifyingDocument('did:web:example.com')).toThrow();
  });
});

describe('did:exprsn for users (Sprint 43, B-113)', () => {
  let h: Harness;
  let dir: string;
  let signer: Awaited<ReturnType<typeof startSigner>>;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'exs-'));
    const socketPath = path.join(dir, 'run', 'signer.sock');
    const token = randomBytes(24).toString('base64url') + 'x'.repeat(8);
    signer = await startSigner({ socketPath, key: randomBytes(32).toString('base64'), token });
    h = await harness({ DATA_KEY: '', SIGNER_SOCKET: socketPath, SIGNER_TOKEN: token, ATPROTO_PUBLIC_URL: 'https://pds.exprsn.test' });
  });
  afterEach(async () => {
    await h.close();
    await signer.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('B-11301, B-11302: a user\'s did:exprsn is minted with a key in the signer, names their PDS DID, and what it signs verifies', async () => {
    const ann = await localUser(h, 'ann', ['member']);
    await localUser(h, 'bea', ['member']);
    const a = await login(h, 'ann');
    const b = await login(h, 'bea');

    // minted on first use, the same on the next request, one per user, each with its own key
    const first = (await a.agent.get('/api/me/atproto/exprsn-did').expect(200)).body as { did: string; curve: string; alsoKnownAs: string[]; document: { verificationMethod: unknown[] } }[];
    expect(first).toHaveLength(1);
    expect(isDidExprsn(first[0]!.did)).toBe(true);
    expect(first[0]).toMatchObject({ curve: 'secp256k1', alsoKnownAs: [] });
    expect((await a.agent.get('/api/me/atproto/exprsn-did').expect(200)).body[0].did).toBe(first[0]!.did);
    const other = (await b.agent.get('/api/me/atproto/exprsn-did').expect(200)).body[0].did as string;
    expect(other).not.toBe(first[0]!.did);
    const row = (await h.s.db('atproto_exprsn_dids').where({ user_id: ann.id }).first()) as { key_ref: string };
    expect(JSON.parse(row.key_ref)).toMatchObject({ custody: 'signer', curve: 'secp256k1' }); // a reference; the key stays in the signer
    expect(await h.s.db('audit_events').where({ action: 'atproto.user-did.minted' })).toHaveLength(2);

    // a label ann signs verifies under her did:exprsn, resolved offline
    const p = (await loadPrincipal(h.s, h.tenantId, ann.id, {}))!;
    const label = await h.s.atproto.userDids.signLabel(p, { uri: 'at://did:plc:aaaaaaaaaaaaaaaaaaaaaaaa/app.bsky.feed.post/3abc', val: 'spam' });
    const doc = await h.s.atproto.resolver.resolve(first[0]!.did);
    const k = labelerFromDocument(doc, first[0]!.did);
    const raw = { ...label, sig: { $bytes: label.sig!.toString('base64') } } as unknown as Record<string, unknown>;
    expect(verifyLabel(raw, readLabel(raw)!, k.curve, k.key)).toBe(true);
    const bk = labelerFromDocument(await offline().resolve(other), other);
    expect(verifyLabel(raw, readLabel(raw)!, bk.curve, bk.key)).toBe(false); // not under bea's key

    // a service-auth token with her did:exprsn as issuer verifies too
    const jwt = await h.s.atproto.userDids.serviceJwt(p, 'did:web:feeds.exprsn.test', 'app.bsky.feed.getFeedSkeleton');
    expect(await new ServiceJwtVerifier(offline()).verify(jwt, { audiences: ['did:web:feeds.exprsn.test'], lxm: 'app.bsky.feed.getFeedSkeleton' })).toEqual({ iss: first[0]!.did });
    await expect(new ServiceJwtVerifier(offline()).verify(jwt, { audiences: ['did:web:other.test'], lxm: 'app.bsky.feed.getFeedSkeleton' })).rejects.toThrow();

    // with an account on this server's PDS, her did:exprsn names its DID, here and in what resolveDid answers
    const pdsDid = 'did:plc:abcdefghijklmnopqrstuvwx';
    await h.s.db('pds_accounts').insert({ id: ulid(), tenant_id: h.tenantId, user_id: ann.id, did: pdsDid, handle: 'ann.pds.exprsn.test', state: 'active', did_method: 'plc', key_curve: 'secp256k1', key_custody: 'signer', key_name: 'x', key_multikey: first[0]!.document.verificationMethod.length ? 'zQ3sh' : 'z', created_at: Date.now(), updated_at: Date.now() });
    expect((await a.agent.get('/api/me/atproto/exprsn-did').expect(200)).body[0].alsoKnownAs).toEqual([pdsDid]);
    const answered = (await request(h.app).get(`/xrpc/com.exprsn.identity.resolveDid?did=${encodeURIComponent(first[0]!.did)}`).expect(200)).body;
    expect(answered).toMatchObject({ did: first[0]!.did, didDoc: { id: first[0]!.did, alsoKnownAs: [pdsDid] } });
    // elsewhere the document is the bare self-certifying one
    expect(((await offline().resolve(first[0]!.did)) as { alsoKnownAs: string[] }).alsoKnownAs).toEqual([]);
    await request(h.app).get('/xrpc/com.exprsn.identity.resolveDid?did=did:exprsn:nope').expect(400);
  });
});
