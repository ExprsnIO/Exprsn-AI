/*
 * 1.9.99-final, Sprint 58 (B-10208): the Azure data planes `FakeAzure` also answers (on the same port).
 *
 * - Key Vault keys (`fake.keyVault`, the vault URL is the fake's own origin, the token's scope
 *   https://vault.azure.net): create (RSA or RSA-HSM, EC or EC-HSM P-256; again on an existing name makes a new
 *   version), get (latest or a version), list, wrapKey and unwrapKey (RSA-OAEP-256), sign (ES256 over the digest
 *   given), delete (soft: the name answers 404 and refuses a new create until purged) and purge.
 * - Blob storage (`fake.blobs`, path style: `<origin>/<account>/<container>/<blob>`, as the storage emulator does):
 *   containers (create, properties, List Blobs with prefix, marker and maxresults), Put Blob, Put Block and Put
 *   Block List, Get Blob with `x-ms-range` (206, 416 on an empty blob) and `If-Match` (412), HEAD, Delete Blob;
 *   Shared Key signatures are checked with the account key, or an Entra token for https://storage.azure.com.
 *
 * Never the real Azure.
 */
import { constants, createHmac, generateKeyPairSync, privateDecrypt, publicEncrypt, randomBytes, randomUUID, type KeyObject } from 'node:crypto';
import type { RecordedRequest, Reply } from './fake-cloud-base.js';
import { xmlEsc } from './fake-cloud-base.js';
import { signDigestP256 } from './fake-ecdsa.js';

interface KvVersion {
  version: string;
  kty: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  ops: string[];
  created: number;
}

interface KvKey {
  name: string;
  versions: KvVersion[];
  tags: Record<string, string>;
  deleted: boolean;
}

const kvErr = (status: number, code: string, message: string): Reply => ({ status, body: { error: { code, message } } });

export class FakeKeyVault {
  readonly keys = new Map<string, KvKey>();
  /** Every operation with its key name and version. */
  readonly log: { op: string; name: string; version?: string; alg?: string }[] = [];

  constructor(private readonly origin: () => string) {}

  matches(path: string): boolean {
    return path === '/keys' || path.startsWith('/keys/') || path.startsWith('/deletedkeys/');
  }

  classify(r: Omit<RecordedRequest, 'op'>): string {
    const parts = r.path.split('/').filter(Boolean);
    if (parts[0] === 'deletedkeys') return `keyvault:purge`;
    if (parts.length === 1) return 'keyvault:list';
    if (parts[2] === 'create') return 'keyvault:create';
    if (parts.length === 4) return `keyvault:${parts[3]}`;
    return r.method === 'DELETE' ? 'keyvault:delete' : 'keyvault:get';
  }

  private bundle(k: KvKey, v: KvVersion) {
    const jwk = v.publicKey.export({ format: 'jwk' }) as Record<string, string>;
    const kid = `${this.origin()}/keys/${k.name}/${v.version}`;
    return { key: { kid, kty: v.kty, key_ops: v.ops, ...(jwk.kty === 'RSA' ? { n: jwk.n, e: jwk.e } : { crv: 'P-256', x: jwk.x, y: jwk.y }) }, attributes: { enabled: true, created: Math.floor(v.created / 1000), updated: Math.floor(v.created / 1000), recoveryLevel: 'Recoverable+Purgeable' }, tags: k.tags };
  }

  handle(r: RecordedRequest): Reply {
    if (!r.query.get('api-version')) return kvErr(400, 'BadParameter', 'The api-version parameter is required');
    const parts = r.path.split('/').filter(Boolean);
    let body: Record<string, unknown>;
    try {
      body = r.body ? (JSON.parse(r.body) as Record<string, unknown>) : {};
    } catch {
      return kvErr(400, 'BadParameter', 'Malformed JSON');
    }
    if (parts[0] === 'deletedkeys') {
      const k = this.keys.get(parts[1] ?? '');
      if (!k || !k.deleted) return kvErr(404, 'KeyNotFound', `Deleted Key not found: ${parts[1]}`);
      this.keys.delete(k.name);
      this.log.push({ op: 'purge', name: k.name });
      return { status: 204 };
    }
    if (parts.length === 1) {
      const live = [...this.keys.values()].filter((k) => !k.deleted);
      return { status: 200, body: { value: live.slice(0, Number(r.query.get('maxresults') ?? 25)).map((k) => ({ kid: `${this.origin()}/keys/${k.name}`, attributes: { enabled: true } })), nextLink: null } };
    }
    const name = parts[1]!;
    if (!/^[0-9a-zA-Z-]{1,127}$/.test(name)) return kvErr(400, 'BadParameter', 'Key name is invalid');
    const k = this.keys.get(name);
    if (parts[2] === 'create' && r.method === 'POST') {
      if (k?.deleted) return kvErr(409, 'Conflict', `Key ${name} is currently in a deleted but recoverable state, and its name cannot be reused; in this state, the key can only be recovered or purged.`);
      const kty = String(body.kty ?? '');
      let pair: { privateKey: KeyObject; publicKey: KeyObject };
      if (kty === 'RSA' || kty === 'RSA-HSM') pair = generateKeyPairSync('rsa', { modulusLength: Number(body.key_size ?? 2048) });
      else if ((kty === 'EC' || kty === 'EC-HSM') && body.crv === 'P-256') pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
      else return kvErr(400, 'BadParameter', `This fake makes RSA and EC P-256 keys, not ${kty} ${String(body.crv ?? '')}`);
      const v: KvVersion = { version: randomBytes(16).toString('hex'), kty, ...pair, ops: (body.key_ops as string[]) ?? [], created: Date.now() };
      const key = k ?? { name, versions: [], tags: (body.tags as Record<string, string>) ?? {}, deleted: false };
      key.versions.push(v);
      this.keys.set(name, key);
      this.log.push({ op: 'create', name, version: v.version });
      return { status: 200, body: this.bundle(key, v) };
    }
    if (!k || k.deleted) return kvErr(404, 'KeyNotFound', `A key with (name/id) ${name} was not found in this key vault.`);
    if (parts.length === 2 && r.method === 'DELETE') {
      k.deleted = true;
      this.log.push({ op: 'delete', name });
      return { status: 200, body: { ...this.bundle(k, k.versions.at(-1)!), recoveryId: `${this.origin()}/deletedkeys/${name}`, deletedDate: Math.floor(Date.now() / 1000) } };
    }
    const v = parts[2] ? k.versions.find((x) => x.version === parts[2]) : k.versions.at(-1);
    if (!v) return kvErr(404, 'KeyNotFound', `A key with (name/id) ${name}/${parts[2]} was not found in this key vault.`);
    if (parts.length <= 3 && r.method === 'GET') return { status: 200, body: this.bundle(k, v) };
    const op = parts[3];
    const kid = `${this.origin()}/keys/${name}/${v.version}`;
    const value = Buffer.from(String(body.value ?? ''), 'base64url');
    const allowed = (o: string) => v.ops.includes(o);
    if (op === 'wrapkey' || op === 'unwrapkey') {
      if (!v.kty.startsWith('RSA') || !allowed(op === 'wrapkey' ? 'wrapKey' : 'unwrapKey')) return kvErr(403, 'Forbidden', `Operation ${op} is not permitted on this key.`);
      if (body.alg !== 'RSA-OAEP-256') return kvErr(400, 'BadParameter', `Algorithm ${String(body.alg)} is not supported here`);
      this.log.push({ op, name, version: v.version, alg: String(body.alg) });
      try {
        const out = op === 'wrapkey' ? publicEncrypt({ key: v.publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, value) : privateDecrypt({ key: v.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, value);
        return { status: 200, body: { kid, value: out.toString('base64url') } };
      } catch {
        return kvErr(400, 'BadParameter', 'The parameter is incorrect.');
      }
    }
    if (op === 'sign') {
      if (!v.kty.startsWith('EC') || !allowed('sign')) return kvErr(403, 'Forbidden', 'Operation sign is not permitted on this key.');
      if (body.alg !== 'ES256' || value.length !== 32) return kvErr(400, 'BadParameter', 'ES256 signs a 32-byte digest');
      this.log.push({ op, name, version: v.version, alg: 'ES256' });
      return { status: 200, body: { kid, value: signDigestP256(v.privateKey, value).toString('base64url') } };
    }
    return kvErr(400, 'BadParameter', `${r.method} ${op ?? ''} is not something this fake answers`);
  }
}

interface StoredBlob {
  data: Buffer;
  contentType: string;
  etag: string;
  modified: number;
}

const blobErr = (status: number, code: string, message: string): Reply => ({ status, headers: { 'x-ms-error-code': code, 'content-type': 'application/xml', 'x-ms-request-id': randomUUID() }, body: `<?xml version="1.0" encoding="utf-8"?><Error><Code>${code}</Code><Message>${xmlEsc(message)}</Message></Error>` });

export class FakeBlobService {
  readonly account = 'exprsnfake';
  readonly accountKey = randomBytes(64).toString('base64');
  readonly containers = new Map<string, Map<string, StoredBlob>>();
  readonly staged = new Map<string, Map<string, Buffer>>();
  /** Requests whose Shared Key signature did not match. */
  badSignatures = 0;

  createContainer(name: string): this {
    if (!this.containers.has(name)) this.containers.set(name, new Map());
    return this;
  }

  matches(path: string): boolean {
    return path === `/${this.account}` || path.startsWith(`/${this.account}/`);
  }

  classify(r: Omit<RecordedRequest, 'op'>): string {
    const [, container, ...rest] = r.path.split('/').filter(Boolean);
    const comp = r.query.get('comp');
    if (!rest.length) return `blob:${r.method} container${comp ? `:${comp}` : ''}${container ? '' : ' (account)'}`;
    return `blob:${r.method} blob${comp ? `:${comp}` : ''}`;
  }

  /** The Shared Key check, written from the service's documented canonical form (not shared with the client). */
  private sharedKeyOk(r: RecordedRequest): boolean {
    const auth = r.headers.authorization ?? '';
    const m = /^SharedKey ([^:]+):(.+)$/.exec(auth);
    if (!m || m[1] !== this.account) return false;
    const h = (n: string) => r.headers[n] ?? '';
    const len = r.raw?.length ?? Buffer.byteLength(r.body);
    const canonHeaders = Object.keys(r.headers).filter((n) => n.startsWith('x-ms-')).sort().map((n) => `${n}:${r.headers[n]!.trim()}\n`).join('');
    const q = new Map<string, string[]>();
    for (const [k, v] of r.query) q.set(k.toLowerCase(), [...(q.get(k.toLowerCase()) ?? []), v]);
    const canonResource = `/${this.account}${r.path}${[...q.keys()].sort().map((k) => `\n${k}:${q.get(k)!.sort().join(',')}`).join('')}`;
    const lines = [r.method, h('content-encoding'), h('content-language'), len ? String(len) : '', h('content-md5'), h('content-type'), '', h('if-modified-since'), h('if-match'), h('if-none-match'), h('if-unmodified-since'), h('range')];
    const expected = createHmac('sha256', Buffer.from(this.accountKey, 'base64')).update(`${lines.join('\n')}\n${canonHeaders}${canonResource}`, 'utf8').digest('base64');
    return expected === m[2];
  }

  handle(r: RecordedRequest): Reply {
    if (r.headers.authorization?.startsWith('SharedKey ') && !this.sharedKeyOk(r)) {
      this.badSignatures += 1;
      return blobErr(403, 'AuthenticationFailed', 'Server failed to authenticate the request. Make sure the value of Authorization header is formed correctly including the signature.');
    }
    if (!r.headers['x-ms-version']) return blobErr(400, 'MissingRequiredHeader', 'An HTTP header that is mandatory for this request is not specified.');
    const [, cname, ...rest] = r.path.split('/').filter(Boolean);
    const blobName = rest.join('/');
    const comp = r.query.get('comp');
    if (!cname) return blobErr(400, 'InvalidUri', 'No container');
    let c = this.containers.get(cname);
    if (!blobName) {
      if (r.query.get('restype') !== 'container') return blobErr(400, 'InvalidQueryParameterValue', 'restype=container is required');
      if (r.method === 'PUT') {
        if (c) return blobErr(409, 'ContainerAlreadyExists', 'The specified container already exists.');
        this.createContainer(cname);
        return { status: 201, headers: { etag: `"${randomUUID()}"` } };
      }
      if (!c) return blobErr(404, 'ContainerNotFound', 'The specified container does not exist.');
      if (r.method === 'GET' && comp === 'list') return this.list(r, c, cname);
      if (r.method === 'GET' || r.method === 'HEAD') return { status: 200, headers: { 'x-ms-lease-state': 'available' } };
      return blobErr(400, 'UnsupportedHttpVerb', r.method);
    }
    if (!c) return blobErr(404, 'ContainerNotFound', 'The specified container does not exist.');
    c = c!;
    const key = `${cname}/${blobName}`;
    const body = r.raw ?? Buffer.from(r.body);
    const store = (data: Buffer, contentType: string): Reply => {
      const b: StoredBlob = { data, contentType, etag: `"0x${randomBytes(8).toString('hex').toUpperCase()}"`, modified: Date.now() };
      c!.set(blobName, b);
      return { status: 201, headers: { etag: b.etag, 'last-modified': new Date(b.modified).toUTCString() } };
    };
    switch (r.method) {
      case 'PUT': {
        if (comp === 'block') {
          const id = r.query.get('blockid') ?? '';
          if (!id) return blobErr(400, 'InvalidQueryParameterValue', 'blockid');
          const s = this.staged.get(key) ?? new Map<string, Buffer>();
          const sameLength = [...s.keys()].every((x) => x.length === id.length);
          if (!sameLength) return blobErr(400, 'InvalidBlobOrBlock', 'The specified blob or block content is invalid.');
          s.set(id, Buffer.from(body));
          this.staged.set(key, s);
          return { status: 201 };
        }
        if (comp === 'blocklist') {
          const ids = [...r.body.matchAll(/<(?:Latest|Uncommitted|Committed)>([^<]+)<\//g)].map((m) => m[1]!);
          const s = this.staged.get(key) ?? new Map<string, Buffer>();
          if (!ids.every((id) => s.has(id))) return blobErr(400, 'InvalidBlockList', 'The specified block list is invalid.');
          const data = Buffer.concat(ids.map((id) => s.get(id)!));
          this.staged.delete(key);
          return store(data, r.headers['x-ms-blob-content-type'] ?? 'application/octet-stream');
        }
        if (r.headers['x-ms-blob-type'] !== 'BlockBlob') return blobErr(400, 'MissingRequiredHeader', 'x-ms-blob-type');
        return store(Buffer.from(body), r.headers['content-type'] ?? 'application/octet-stream');
      }
      case 'GET':
      case 'HEAD': {
        const b = c.get(blobName);
        if (!b) return r.method === 'HEAD' ? { status: 404, headers: { 'x-ms-error-code': 'BlobNotFound' } } : blobErr(404, 'BlobNotFound', 'The specified blob does not exist.');
        if (r.headers['if-match'] && r.headers['if-match'] !== b.etag) return blobErr(412, 'ConditionNotMet', 'The condition specified using HTTP conditional header(s) is not met.');
        const base = { etag: b.etag, 'content-type': b.contentType, 'last-modified': new Date(b.modified).toUTCString(), 'x-ms-blob-type': 'BlockBlob', 'accept-ranges': 'bytes' };
        if (r.method === 'HEAD') return { status: 200, headers: { ...base, 'content-length': String(b.data.length) } };
        const range = /^bytes=(\d+)-(\d*)$/.exec(r.headers['x-ms-range'] ?? r.headers.range ?? '');
        if (!range) return { status: 200, headers: base, body: b.data };
        const start = Number(range[1]);
        const end = Math.min(range[2] ? Number(range[2]) : b.data.length - 1, b.data.length - 1);
        if (start >= b.data.length) return blobErr(416, 'InvalidRange', 'The range specified is invalid for the current size of the resource.');
        return { status: 206, headers: { ...base, 'content-range': `bytes ${start}-${end}/${b.data.length}` }, body: b.data.subarray(start, end + 1) };
      }
      case 'DELETE':
        if (!c.delete(blobName)) return blobErr(404, 'BlobNotFound', 'The specified blob does not exist.');
        return { status: 202, headers: { 'x-ms-delete-type-permanent': 'true' } };
    }
    return blobErr(400, 'UnsupportedHttpVerb', r.method);
  }

  private list(r: RecordedRequest, c: Map<string, StoredBlob>, cname: string): Reply {
    const prefix = r.query.get('prefix') ?? '';
    const max = Math.min(5000, Number(r.query.get('maxresults') ?? 5000));
    const marker = r.query.get('marker') ?? '';
    const names = [...c.keys()].filter((n) => n.startsWith(prefix)).sort();
    const from = marker ? names.findIndex((n) => n > Buffer.from(marker, 'base64url').toString('utf8')) : 0;
    const page = from < 0 ? [] : names.slice(from, from + max);
    const next = from >= 0 && from + max < names.length ? Buffer.from(page.at(-1)!).toString('base64url') : '';
    const items = page.map((n) => {
      const b = c.get(n)!;
      return `<Blob><Name>${xmlEsc(n)}</Name><Properties><Last-Modified>${new Date(b.modified).toUTCString()}</Last-Modified><Etag>${b.etag}</Etag><Content-Length>${b.data.length}</Content-Length><Content-Type>${xmlEsc(b.contentType)}</Content-Type><BlobType>BlockBlob</BlobType></Properties></Blob>`;
    });
    const xml = `<?xml version="1.0" encoding="utf-8"?><EnumerationResults ServiceEndpoint="http://fake/${this.account}" ContainerName="${cname}"><Prefix>${xmlEsc(prefix)}</Prefix><MaxResults>${max}</MaxResults><Blobs>${items.join('')}</Blobs><NextMarker>${next}</NextMarker></EnumerationResults>`;
    return { status: 200, headers: { 'content-type': 'application/xml' }, body: xml };
  }
}
