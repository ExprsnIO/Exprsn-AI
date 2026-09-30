import { createPublicKey, generateKeyPairSync, createHash, randomBytes, sign, verify, type KeyObject } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { bits, bool, int, name, octets, OID, oid, sanValue, seq, tagged, time, toPem } from '../src/ops/der.js';

/** A minimal DER reader: the children of a constructed value. */
function children(buf: Buffer): { tag: number; raw: Buffer; content: Buffer }[] {
  const out: { tag: number; raw: Buffer; content: Buffer }[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const tag = buf[pos]!;
    let len = buf[pos + 1]!;
    let hdr = 2;
    if (len & 0x80) {
      const n = len & 0x7f;
      len = 0;
      for (let i = 0; i < n; i++) len = len * 256 + buf[pos + 2 + i]!;
      hdr += n;
    }
    out.push({ tag, raw: buf.subarray(pos, pos + hdr + len), content: buf.subarray(pos + hdr, pos + hdr + len) });
    pos += hdr + len;
  }
  return out;
}

/** dNSName values anywhere inside a DER value. */
function dnsNames(buf: Buffer): string[] {
  const names: string[] = [];
  for (const c of children(buf)) {
    if (c.tag === 0x82) names.push(c.content.toString('ascii'));
    else if (c.tag & 0x20) names.push(...dnsNames(c.content));
    else if (c.tag === 0x04) {
      try {
        names.push(...dnsNames(c.content));
      } catch {
        // not DER inside
      }
    }
  }
  return names;
}

function certificate(o: { serial: Buffer; issuer: string; subject: string; spki: Buffer; notBefore: number; notAfter: number; domains?: string[]; ca?: boolean; key: KeyObject }): Buffer {
  const ext: Buffer[] = [];
  if (o.domains?.length) ext.push(seq(oid(OID.subjectAltName), octets(sanValue(o.domains))));
  if (o.ca) ext.push(seq(oid(OID.basicConstraints), bool(true), octets(seq(bool(true)))));
  const tbs = seq(tagged(0, true, int(2)), int(o.serial), seq(oid(OID.ecdsaSha256)), name(o.issuer), seq(time(o.notBefore), time(o.notAfter)), name(o.subject), o.spki, ...(ext.length ? [tagged(3, true, seq(...ext))] : []));
  return seq(tbs, seq(oid(OID.ecdsaSha256)), bits(sign('sha256', tbs, o.key)));
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const thumb = (jwk: Record<string, string>) => b64u(createHash('sha256').update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest());

export interface FakeAcme {
  url: string;
  directory: string;
  caPem: string;
  issued: { serial: string; domains: string[] }[];
  revoked: string[];
  /** Days a certificate is valid for (change between orders to test renewal). */
  validityDays: number;
  close(): Promise<void>;
}

/**
 * An in-process RFC 8555 directory: nonces, JWS verification (ES256, jwk and kid), accounts, orders, http-01
 * validation through the `validate` callback (instead of dialling the domain), dns-01 validation through the injected
 * `resolveTxt` (the TXT records at `_acme-challenge.<name>` must include base64url(sha256(key authorization))),
 * wildcard identifiers (dns-01 only), finalize with CSR checks, a PEM chain signed by its own CA, and revocation.
 */
export async function startFakeAcme(validate: (domain: string, token: string) => Promise<string | null>, opts: { resolveTxt?: (name: string) => Promise<string[]> } = {}): Promise<FakeAcme> {
  const ca = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const caSpki = createPublicKey(ca.privateKey).export({ type: 'spki', format: 'der' });
  const caDer = certificate({ serial: randomBytes(8), issuer: 'Fake internal CA', subject: 'Fake internal CA', spki: caSpki, notBefore: Date.now() - 86_400_000, notAfter: Date.now() + 3650 * 86_400_000, ca: true, key: ca.privateKey });
  const caPem = toPem(caDer);
  const nonces = new Set<string>();
  const accounts = new Map<string, Record<string, string>>();
  const orders = new Map<string, { status: string; identifiers: { type: string; value: string }[]; authorizations: string[]; finalize: string; certificate?: string; pem?: string; account: string }>();
  const authzs = new Map<string, { status: string; identifier: { type: string; value: string }; wildcard: boolean; token: string; order: string; account: string; challengeStatus: string; dnsStatus: string; error?: string }>();
  let n = 0;
  let base = '';
  const fake: FakeAcme = { url: '', directory: '', caPem, issued: [], revoked: [], validityDays: 90, close: async () => undefined };

  const newNonce = () => {
    const x = b64u(randomBytes(12));
    nonces.add(x);
    return x;
  };

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        const path = req.url ?? '/';
        const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
          res.writeHead(status, { 'replay-nonce': newNonce(), 'content-type': typeof body === 'string' ? 'application/pem-certificate-chain' : body === undefined ? 'text/plain' : status >= 400 ? 'application/problem+json' : 'application/json', ...headers });
          res.end(body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body));
        };
        const problem = (status: number, type: string, detail: string) => send(status, { type: `urn:ietf:params:acme:error:${type}`, detail, status });
        if (req.method === 'GET' && path === '/directory') return send(200, { newNonce: `${base}/new-nonce`, newAccount: `${base}/new-account`, newOrder: `${base}/new-order`, revokeCert: `${base}/revoke-cert` });
        if (path === '/new-nonce') return send(req.method === 'HEAD' ? 200 : 204, undefined);
        if (req.method !== 'POST') return problem(405, 'malformed', 'POST only');
        // JWS checks
        let jws: { protected: string; payload: string; signature: string };
        try {
          jws = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof jws;
        } catch {
          return problem(400, 'malformed', 'not JSON');
        }
        const header = JSON.parse(Buffer.from(jws.protected, 'base64url').toString('utf8')) as { alg: string; nonce: string; url: string; jwk?: Record<string, string>; kid?: string };
        if (header.alg !== 'ES256') return problem(400, 'badSignatureAlgorithm', 'ES256 only');
        if (!nonces.delete(header.nonce)) return problem(400, 'badNonce', 'unknown nonce');
        if (header.url !== `${base}${path}`) return problem(400, 'unauthorized', 'url mismatch');
        let jwk: Record<string, string> | undefined;
        let account: string | undefined;
        if (path === '/new-account') jwk = header.jwk;
        else {
          account = header.kid?.slice(base.length + '/acct/'.length);
          jwk = account ? accounts.get(account) : undefined;
        }
        if (!jwk) return problem(401, 'accountDoesNotExist', 'unknown account');
        const pub = createPublicKey({ key: jwk, format: 'jwk' });
        if (!verify('sha256', Buffer.from(`${jws.protected}.${jws.payload}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(jws.signature, 'base64url'))) return problem(400, 'unauthorized', 'bad signature');
        const payload = jws.payload ? (JSON.parse(Buffer.from(jws.payload, 'base64url').toString('utf8')) as Record<string, unknown>) : null;

        if (path === '/new-account') {
          const existing = [...accounts.entries()].find(([, k]) => thumb(k) === thumb(jwk));
          if (existing) return send(200, { status: 'valid' }, { location: `${base}/acct/${existing[0]}` });
          const id = String(++n);
          accounts.set(id, jwk);
          return send(201, { status: 'valid', contact: payload?.contact }, { location: `${base}/acct/${id}` });
        }
        if (path === '/new-order') {
          const oid2 = String(++n);
          const identifiers = (payload?.identifiers ?? []) as { type: string; value: string }[];
          const auth = identifiers.map((idf) => {
            const aid = String(++n);
            const wildcard = idf.value.startsWith('*.');
            authzs.set(aid, { status: 'pending', identifier: { type: idf.type, value: idf.value.replace(/^\*\./, '') }, wildcard, token: b64u(randomBytes(16)), order: oid2, account: account!, challengeStatus: 'pending', dnsStatus: 'pending' });
            return `${base}/authz/${aid}`;
          });
          const o = { status: 'pending', identifiers, authorizations: auth, finalize: `${base}/finalize/${oid2}`, account: account! };
          orders.set(oid2, o);
          return send(201, { status: o.status, identifiers, authorizations: auth, finalize: o.finalize }, { location: `${base}/order/${oid2}` });
        }
        let m = /^\/authz\/(\d+)$/.exec(path);
        if (m) {
          const a = authzs.get(m[1]!);
          if (!a) return problem(404, 'malformed', 'no authz');
          const err = a.error ? { error: { detail: a.error } } : {};
          // A wildcard can only be proven with dns-01 (RFC 8555 section 7.1.3).
          return send(200, { status: a.status, identifier: a.identifier, ...(a.wildcard ? { wildcard: true } : {}), challenges: [{ type: 'dns-01', url: `${base}/chall-dns/${m[1]}`, token: a.token, status: a.dnsStatus, ...(a.dnsStatus === 'invalid' ? err : {}) }, ...(a.wildcard ? [] : [{ type: 'http-01', url: `${base}/chall/${m[1]}`, token: a.token, status: a.challengeStatus, ...(a.challengeStatus === 'invalid' ? err : {}) }])] });
        }
        m = /^\/chall-dns\/(\d+)$/.exec(path);
        if (m) {
          const a = authzs.get(m[1]!)!;
          const expected = b64u(createHash('sha256').update(`${a.token}.${thumb(accounts.get(a.account)!)}`).digest());
          const records = opts.resolveTxt ? await opts.resolveTxt(`_acme-challenge.${a.identifier.value}`).catch(() => []) : [];
          const ok = records.includes(expected);
          a.status = a.dnsStatus = ok ? 'valid' : 'invalid';
          if (!ok) a.error = `no TXT record ${expected} at _acme-challenge.${a.identifier.value} (found ${records.join(', ') || 'none'})`;
          const o = orders.get(a.order)!;
          const all = o.authorizations.map((u) => authzs.get(u.split('/').pop()!)!);
          if (all.every((x) => x.status === 'valid')) o.status = 'ready';
          else if (all.some((x) => x.status === 'invalid')) o.status = 'invalid';
          return send(200, { type: 'dns-01', url: `${base}${path}`, token: a.token, status: a.dnsStatus });
        }
        m = /^\/chall\/(\d+)$/.exec(path);
        if (m) {
          const a = authzs.get(m[1]!)!;
          a.challengeStatus = 'processing';
          const expected = `${a.token}.${thumb(accounts.get(a.account)!)}`;
          const got = await validate(a.identifier.value, a.token);
          a.status = a.challengeStatus = got === expected ? 'valid' : 'invalid';
          if (got !== expected) a.error = `expected ${expected}, got ${String(got)}`;
          const o = orders.get(a.order)!;
          const all = o.authorizations.map((u) => authzs.get(u.split('/').pop()!)!);
          if (all.every((x) => x.status === 'valid')) o.status = 'ready';
          else if (all.some((x) => x.status === 'invalid')) o.status = 'invalid';
          return send(200, { type: 'http-01', url: `${base}${path}`, token: a.token, status: a.challengeStatus });
        }
        m = /^\/order\/(\d+)$/.exec(path);
        if (m) {
          const o = orders.get(m[1]!)!;
          return send(200, { status: o.status, identifiers: o.identifiers, authorizations: o.authorizations, finalize: o.finalize, ...(o.certificate ? { certificate: o.certificate } : {}) });
        }
        m = /^\/finalize\/(\d+)$/.exec(path);
        if (m) {
          const o = orders.get(m[1]!)!;
          if (o.status !== 'ready') return problem(403, 'orderNotReady', `order is ${o.status}`);
          const csr = Buffer.from(String(payload?.csr), 'base64url');
          const [outer] = children(csr);
          const [info, , sig] = children(outer!.content);
          const [, , spki, attrs] = children(info!.content);
          if (!verify('sha256', info!.raw, createPublicKey({ key: spki!.raw, format: 'der', type: 'spki' }), sig!.content.subarray(1))) return problem(400, 'badCSR', 'CSR signature does not verify');
          const sans = dnsNames(attrs!.content).sort();
          const want = o.identifiers.map((x) => x.value).sort();
          if (JSON.stringify(sans) !== JSON.stringify(want)) return problem(400, 'badCSR', `CSR names ${sans.join(',')} do not match the order`);
          const serial = randomBytes(8);
          serial[0] = serial[0]! & 0x7f;
          const leaf = certificate({ serial, issuer: 'Fake internal CA', subject: want[0]!, spki: spki!.raw, notBefore: Date.now() - 60_000, notAfter: Date.now() + fake.validityDays * 86_400_000, domains: want, key: ca.privateKey });
          o.pem = toPem(leaf) + caPem;
          o.status = 'valid';
          o.certificate = `${base}/cert/${m[1]}`;
          fake.issued.push({ serial: serial.toString('hex').toUpperCase(), domains: want });
          return send(200, { status: o.status, finalize: o.finalize, certificate: o.certificate, identifiers: o.identifiers, authorizations: o.authorizations });
        }
        m = /^\/cert\/(\d+)$/.exec(path);
        if (m) return send(200, orders.get(m[1]!)!.pem!);
        if (path === '/revoke-cert') {
          const der = Buffer.from(String(payload?.certificate), 'base64url');
          const tbs = children(children(der)[0]!.content)[0]!;
          const serial = children(tbs.content)[1]!.content;
          fake.revoked.push(serial.toString('hex').toUpperCase().replace(/^00/, ''));
          return send(200, undefined);
        }
        return problem(404, 'malformed', 'no route');
      })().catch((err: Error) => {
        res.writeHead(500);
        res.end(err.message);
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.url = base;
  fake.directory = `${base}/directory`;
  fake.close = () => new Promise((resolve) => server.close(() => resolve()));
  return fake;
}
