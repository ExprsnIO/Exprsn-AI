import { ulid } from 'ulid';
import type { Services } from '../../services.js';
import { pdsOf, isResolvableDid, refusalOf } from '../handles.js';
import { ServiceUrlRefused } from '../../platform/egress.js';
import { isRecordKey } from './syntax.js';
import { XrpcError, type PdsActor, type PdsService } from './service.js';

/*
 * Publishing a feed generator (B-3004): the `app.bsky.feed.generator` record that tells the network a feed exists and
 * which service (by DID) answers `getFeedSkeleton` for it. The feed generator service itself is B-3001 to B-3003; this
 * step takes its service DID and metadata and writes the record:
 *
 * - into a repo this PDS hosts for the tenant (`hosted`), through the same commit pipeline as any write, so it is
 *   validated against the lexicon and sequenced on the firehose; or
 * - into an external account (`external`), at that account's own PDS: a session is made with the identifier and an app
 *   password given for this call only (never stored), then `putRecord`; every address goes through the service URL
 *   checks (B-901).
 *
 * The record is read back and must name the service DID. Published records are kept in `pds_feed_records` so the
 * AT-Protocol screen can list and withdraw them. The record and its metadata are public by protocol.
 *
 * A feed defined under `/api/atproto/feeds` is published with `publishFeed`: the record is the generator's own
 * (`feedGenerators.recordFor`), and the feed records the publication (`feedGenerators.markPublished`); withdrawing the
 * record forgets it again.
 */

export const GENERATOR = 'app.bsky.feed.generator';

export interface GeneratorInput {
  serviceDid: string;
  rkey: string;
  displayName: string;
  description?: string | undefined;
  acceptsInteractions?: boolean | undefined;
  contentMode?: 'app.bsky.feed.defs#contentModeUnspecified' | 'app.bsky.feed.defs#contentModeVideo' | undefined;
}

export type PublishTarget = { kind: 'hosted'; accountId: string } | { kind: 'external'; identifier: string; appPassword: string; pdsUrl?: string | undefined };

export interface FeedRecordRow {
  id: string;
  tenant_id: string;
  target: 'hosted' | 'external';
  account_id: string | null;
  repo: string;
  rkey: string;
  uri: string;
  cid: string;
  service_did: string;
  display_name: string;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

const rowFrom = (r: Record<string, unknown>): FeedRecordRow => ({ ...(r as unknown as FeedRecordRow), created_at: Number(r.created_at), updated_at: Number(r.updated_at) });

export const feedRecordView = (r: FeedRecordRow) => ({ id: r.id, target: r.target, accountId: r.account_id, repo: r.repo, rkey: r.rkey, uri: r.uri, cid: r.cid, serviceDid: r.service_did, displayName: r.display_name, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at });

export class PdsFeeds {
  constructor(
    private readonly pds: PdsService,
    private readonly s: () => Services
  ) {}

  private get db() {
    return this.s().db;
  }

  /** The generator record (lex JSON) for the metadata. */
  static record(input: GeneratorInput, createdAt = new Date().toISOString()): Record<string, unknown> {
    return {
      $type: GENERATOR,
      did: input.serviceDid,
      displayName: input.displayName,
      ...(input.description ? { description: input.description } : {}),
      ...(input.acceptsInteractions !== undefined ? { acceptsInteractions: input.acceptsInteractions } : {}),
      ...(input.contentMode ? { contentMode: input.contentMode } : {}),
      createdAt
    };
  }

  async list(tenantId: string): Promise<FeedRecordRow[]> {
    return ((await this.db('pds_feed_records').where({ tenant_id: tenantId }).orderBy('created_at', 'desc')) as Record<string, unknown>[]).map(rowFrom);
  }

  async get(tenantId: string, id: string): Promise<FeedRecordRow | undefined> {
    const r = (await this.db('pds_feed_records').where({ tenant_id: tenantId, id }).first()) as Record<string, unknown> | undefined;
    return r ? rowFrom(r) : undefined;
  }

  private check(input: GeneratorInput): void {
    if (!isResolvableDid(input.serviceDid)) throw new XrpcError(400, 'InvalidRequest', 'The generator’s service DID is a did:web or did:plc.');
    if (!isRecordKey(input.rkey) || input.rkey.length > 64) throw new XrpcError(400, 'InvalidRequest', 'The feed’s record key is 1 to 64 letters, digits, dots, hyphens, underscores, colons or tildes.');
  }

  /** Publishes (or replaces) the generator record built from the metadata; returns where it is. */
  async publish(by: PdsActor, tenantId: string, target: PublishTarget, input: GeneratorInput): Promise<FeedRecordRow> {
    this.check(input);
    return this.publishRecord(by, tenantId, target, input.rkey, PdsFeeds.record(input));
  }

  /**
   * Publishes a generator record value as given (`$type` app.bsky.feed.generator, `did` the service DID), e.g. the one
   * the feed generator service builds for a feed (B-3001 to B-3003: `feedGenerators.recordFor(row, generatorDid)`,
   * after which the caller records the publication with `feedGenerators.markPublished(by, row, { did, uri, cid })`).
   */
  async publishRecord(by: PdsActor, tenantId: string, target: PublishTarget, rkey: string, record: Record<string, unknown>): Promise<FeedRecordRow> {
    const input = { serviceDid: String(record.did ?? ''), rkey, displayName: String(record.displayName ?? '') };
    this.check(input);
    if (record.$type !== GENERATOR) throw new XrpcError(400, 'InvalidRequest', `The record must be an ${GENERATOR}.`);
    let repo: string;
    let uri: string;
    let cid: string;
    let accountId: string | null = null;
    if (target.kind === 'hosted') {
      const a = await this.pds.accountById(target.accountId);
      if (!a || a.tenant_id !== tenantId) throw new XrpcError(404, 'NotFound', 'No such account in this tenant.');
      const r = await this.pds.repo.applyWrites(by, a, [{ action: (await this.pds.repo.getRecord(a, GENERATOR, input.rkey)) ? 'update' : 'create', collection: GENERATOR, rkey: input.rkey, value: record }], { validate: true });
      const back = await this.pds.repo.getRecord(a, GENERATOR, input.rkey);
      if (!back || (back.value as { did?: unknown }).did !== input.serviceDid) throw new Error('The published generator record does not name the service DID');
      repo = a.did;
      uri = r.results[0]!.uri;
      cid = r.results[0]!.cid!;
      accountId = a.id;
    } else {
      const out = await this.external(target, 'put', input.rkey, record);
      repo = out.did;
      uri = out.uri;
      cid = out.cid;
    }
    const now = Date.now();
    const existing = (await this.db('pds_feed_records').where({ tenant_id: tenantId, uri }).first('id')) as { id: string } | undefined;
    const id = existing?.id ?? ulid();
    if (existing) await this.db('pds_feed_records').where({ id }).update({ cid, service_did: input.serviceDid, display_name: input.displayName.slice(0, 64), updated_at: now });
    else await this.db('pds_feed_records').insert({ id, tenant_id: tenantId, target: target.kind, account_id: accountId, repo, rkey: input.rkey, uri, cid, service_did: input.serviceDid, display_name: input.displayName.slice(0, 64), created_by: by.userId, created_at: now, updated_at: now });
    await this.pds.audit(by, 'pds.feed.published', { feedRecord: id, uri }, { target: target.kind, serviceDid: input.serviceDid, cid, replaced: !!existing });
    return (await this.get(tenantId, id))!;
  }

  /**
   * Publishes the generator record of a feed defined under `/api/atproto/feeds` (B-3001 to B-3003): the record the
   * feed generator builds for it (naming the generator's service DID, under the feed's record key), then records the
   * publication on the feed, whose `at://` URI follows it from then on.
   */
  async publishFeed(by: PdsActor, tenantId: string, target: PublishTarget, feedId: string): Promise<FeedRecordRow> {
    const fg = this.s().feedGenerators;
    const row = await fg.get(tenantId, feedId);
    if (!row) throw new XrpcError(404, 'NotFound', 'No such feed in this tenant.');
    const g = await fg.generator(tenantId);
    if (!g.did) throw new XrpcError(409, 'InvalidRequest', g.reason ?? 'The tenant has no feed generator.');
    const out = await this.publishRecord(by, tenantId, target, row.rkey, fg.recordFor(row, g.did));
    await fg.markPublished(by, row, { did: out.repo, uri: out.uri, cid: out.cid });
    return out;
  }

  /** Withdraws a published generator record (an external one needs its credentials again). */
  async withdraw(by: PdsActor, row: FeedRecordRow, creds?: { identifier: string; appPassword: string; pdsUrl?: string | undefined }): Promise<void> {
    if (row.target === 'hosted') {
      const a = row.account_id ? await this.pds.accountById(row.account_id) : undefined;
      if (a && (await this.pds.repo.getRecord(a, GENERATOR, row.rkey))) await this.pds.repo.applyWrites(by, a, [{ action: 'delete', collection: GENERATOR, rkey: row.rkey }]);
    } else {
      if (!creds) throw new XrpcError(400, 'InvalidRequest', 'Withdrawing a record from an external account needs its identifier and an app password.');
      await this.external({ kind: 'external', ...creds }, 'delete', row.rkey, null);
    }
    await this.db('pds_feed_records').where({ id: row.id }).delete();
    await this.pds.audit(by, 'pds.feed.withdrawn', { feedRecord: row.id, uri: row.uri }, { target: row.target });
    // A feed published as this record forgets the publication (its URI falls back to the generator's DID).
    const fg = this.s().feedGenerators;
    for (const f of await fg.list(row.tenant_id)) if (f.record_uri === row.uri) await fg.markPublished(by, f, null);
  }

  /** Writes to an external account's PDS through the service URL checks; the app password is used once and dropped. */
  private async external(t: Extract<PublishTarget, { kind: 'external' }>, op: 'put' | 'delete', rkey: string, record: Record<string, unknown> | null): Promise<{ did: string; uri: string; cid: string }> {
    const s = this.s();
    const http = s.atproto.http;
    const call = async (url: string, init: Parameters<typeof http.request>[1]) => {
      try {
        return await http.request(url, init);
      } catch (err) {
        const refused = err instanceof ServiceUrlRefused ? err : refusalOf(err);
        throw new XrpcError(502, 'UpstreamFailure', refused ? `The account's PDS was refused: ${refused.message}` : `The account's PDS could not be reached: ${(err as Error).message}`);
      }
    };
    let base = t.pdsUrl?.replace(/\/+$/, '') ?? null;
    if (!base) {
      let did = t.identifier;
      if (!did.startsWith('did:')) {
        try {
          did = (await s.atprotoAccounts.handles.resolve(t.identifier)).did;
        } catch (err) {
          throw new XrpcError(400, 'InvalidRequest', `The handle could not be resolved: ${(err as Error).message}`);
        }
      }
      try {
        base = pdsOf(await s.atproto.resolver.resolve(did, true), did);
      } catch (err) {
        throw new XrpcError(502, 'UpstreamFailure', `${did} could not be resolved: ${(err as Error).message}`);
      }
      if (!base) throw new XrpcError(400, 'InvalidRequest', `${did} names no PDS.`);
    }
    const session = await call(`${base}/xrpc/com.atproto.server.createSession`, { method: 'POST', body: { identifier: t.identifier, password: t.appPassword } });
    const sj = session.json as { accessJwt?: unknown; did?: unknown } | null;
    if (session.status !== 200 || typeof sj?.accessJwt !== 'string' || typeof sj.did !== 'string') throw new XrpcError(400, 'AuthenticationRequired', `The account's PDS refused the sign-in (${session.status}).`);
    const headers = { authorization: `Bearer ${sj.accessJwt}` };
    try {
      if (op === 'delete') {
        const r = await call(`${base}/xrpc/com.atproto.repo.deleteRecord`, { method: 'POST', body: { repo: sj.did, collection: GENERATOR, rkey }, headers });
        if (r.status !== 200) throw new XrpcError(502, 'UpstreamFailure', `deleteRecord failed (${r.status}): ${r.text.slice(0, 200)}`);
        return { did: sj.did, uri: `at://${sj.did}/${GENERATOR}/${rkey}`, cid: '' };
      }
      const r = await call(`${base}/xrpc/com.atproto.repo.putRecord`, { method: 'POST', body: { repo: sj.did, collection: GENERATOR, rkey, record, validate: true }, headers });
      const rj = r.json as { uri?: unknown; cid?: unknown } | null;
      if (r.status !== 200 || typeof rj?.uri !== 'string' || typeof rj.cid !== 'string') throw new XrpcError(502, 'UpstreamFailure', `putRecord failed (${r.status}): ${r.text.slice(0, 200)}`);
      const back = await call(`${base}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(sj.did)}&collection=${GENERATOR}&rkey=${encodeURIComponent(rkey)}`, {});
      const bj = back.json as { value?: { did?: unknown } } | null;
      if (back.status !== 200 || bj?.value?.did !== (record as { did: string }).did) throw new XrpcError(502, 'UpstreamFailure', 'The account’s PDS did not keep the record as written.');
      return { did: sj.did, uri: rj.uri, cid: rj.cid };
    } finally {
      // Best effort: end the session made for this call.
      const refresh = (session.json as { refreshJwt?: unknown }).refreshJwt;
      if (typeof refresh === 'string') void http.request(`${base}/xrpc/com.atproto.server.deleteSession`, { method: 'POST', headers: { authorization: `Bearer ${refresh}` } }).catch(() => undefined);
    }
  }
}
