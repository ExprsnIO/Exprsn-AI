import { actorFrom } from '../audit/chain.js';
import type { Principal } from '../authz/policy.js';
import { loadPrincipal } from '../http/middleware.js';
import { conflict } from '../http/problem.js';
import { stripBuffer } from '../files/exif.js';
import { dataToJson } from '../atproto/pds/lexjson.js';
import type { PdsAccountRow, PdsActor } from '../atproto/pds/service.js';
import { TOPICS } from '../platform/bus.js';
import type { Services } from '../services.js';

/*
 * 1.7.0, Sprint 43 (B-11402, B-11403, decision D6b, FEED-13): cross-posting public feed posts to the author's repo on
 * this server's own PDS.
 *
 * An author who opts in (`feed_crosspost_authors`) and has an active account on the PDS has each post that is
 * published, marked public (visibility `public`) and labelled public written as an `app.bsky.feed.post` record in their
 * repo: the text with link and hashtag facets, up to four images as blobs (the file name is the alt text: posts have
 * no alt text of their own), and a link back to the post in the console. An edit updates the record; a delete,
 * a change of visibility or label, or a hide removes it; a takedown also emits `!takedown` on the record's at-uri,
 * and a restore after an appeal writes the record again and negates that label. Workspace and unlisted posts, posts
 * labelled above public, and held posts (until a reviewer accepts them) are never written. A repost carries no text of
 * its own and is not written.
 *
 * Every change of a post queues the job `feed.crosspost` for it, which compares what the post should be in the repo
 * with what was written (`feed_crossposts`) and makes one write: so a retry, a missed event or a change of mind all
 * end in the right state. The external half (another PDS) is not built; nothing leaves this server but what the
 * relay crawls from the PDS.
 */

export const CROSSPOST_JOB = 'feed.crosspost';
const COLLECTION = 'app.bsky.feed.post';
const MAX_GRAPHEMES = 300;
const MAX_IMAGES = 4;
const IMAGE_MAX_BYTES = 1_000_000;

export interface CrosspostRow {
  post_id: string;
  tenant_id: string;
  author_id: string;
  account_id: string;
  did: string;
  rkey: string;
  uri: string;
  cid: string | null;
  state: 'written' | 'deleted' | 'failed';
  reason: string | null;
  error: string | null;
  updated_at: number;
}

const graphemes = (s: string): string[] => [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(s)].map((x) => x.segment);

/** The text and its facets: links (http/https) and hashtags, with UTF-8 byte offsets as the lexicon asks. */
export function textWithFacets(body: string, link: string): { text: string; facets: Record<string, unknown>[] } {
  const tail = `\n\n${link}`;
  const room = MAX_GRAPHEMES - graphemes(tail).length;
  let main = body.trim();
  const g = graphemes(main);
  if (g.length > room) main = g.slice(0, Math.max(0, room - 1)).join('').trimEnd() + '…';
  const text = main + tail;
  const facets: Record<string, unknown>[] = [];
  const at = (index: number) => Buffer.byteLength(text.slice(0, index), 'utf8');
  for (const m of text.matchAll(/https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]]/g)) {
    facets.push({ index: { byteStart: at(m.index!), byteEnd: at(m.index! + m[0].length) }, features: [{ $type: 'app.bsky.richtext.facet#link', uri: m[0] }] });
  }
  for (const m of main.matchAll(/(^|\s)#([\p{L}\p{N}_]{1,64})/gu)) {
    const start = m.index! + m[1]!.length;
    facets.push({ index: { byteStart: at(start), byteEnd: at(start + 1 + m[2]!.length) }, features: [{ $type: 'app.bsky.richtext.facet#tag', tag: m[2] }] });
  }
  return { text, facets };
}

export class FeedCrosspost {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  // ---------- the author's choice ----------

  async enabled(tenantId: string, userId: string): Promise<boolean> {
    const r = (await this.db('feed_crosspost_authors').where({ tenant_id: tenantId, user_id: userId }).first('enabled')) as { enabled: boolean | number } | undefined;
    return !!r?.enabled;
  }

  private async account(tenantId: string, userId: string): Promise<PdsAccountRow | null> {
    const a = await this.s().pds.accountByUser(userId);
    return a && a.tenant_id === tenantId ? a : null;
  }

  /** The caller's setting, and whether they can cross-post at all (an active account on this PDS). */
  async settings(p: Principal) {
    const a = await this.account(p.tenantId, p.userId);
    return { enabled: await this.enabled(p.tenantId, p.userId), account: a ? { did: a.did, handle: a.handle, state: a.state } : null, ready: !!a && a.state === 'active' };
  }

  async setEnabled(p: Principal, enabled: boolean, ctx: { ip?: string | null; traceId?: string | null } = {}) {
    const a = await this.account(p.tenantId, p.userId);
    if (enabled && (!a || a.state !== 'active')) throw conflict('Cross-posting writes to your account on this server\'s PDS; create one (AT-Protocol, account) first.');
    const t = Date.now();
    await this.db.transaction(async (trx) => {
      await trx('feed_crosspost_authors').where({ tenant_id: p.tenantId, user_id: p.userId }).delete();
      await trx('feed_crosspost_authors').insert({ tenant_id: p.tenantId, user_id: p.userId, enabled, updated_at: t });
    });
    await this.s().audit.append({ tenantId: p.tenantId, action: enabled ? 'feed.crosspost.enabled' : 'feed.crosspost.disabled', kind: 'admin', actor: actorFrom(p, ctx.ip ?? null), target: { user: p.userId }, detail: { did: a?.did ?? null }, traceId: ctx.traceId ?? null });
    return this.settings(p);
  }

  /** A post's cross-post status, for its author. */
  async status(p: Principal, postId: string) {
    const r = (await this.db('feed_crossposts').where({ tenant_id: p.tenantId, post_id: postId }).first()) as CrosspostRow | undefined;
    if (!r || r.author_id !== p.userId) return { state: 'none' as const };
    // never written: `skipped`, with the reason (a workspace post, an author who does not cross-post, ...)
    return { state: r.state === 'deleted' && !r.uri ? 'skipped' : r.state, uri: r.state === 'written' ? r.uri : null, reason: r.reason, error: r.error, updatedAt: Number(r.updated_at) };
  }

  // ---------- keeping the repo in step ----------

  listen(): void {
    const s = this.s();
    s.jobs.register(CROSSPOST_JOB, async (payload) => this.sync(String(payload.tenantId), String(payload.postId), payload.takedown === true ? 'takedown' : payload.restore === true ? 'restore' : null), { timeoutMs: 2 * 60_000 });
    s.bus.on<{ tenantId: string; type: string; data?: Record<string, unknown> }>(TOPICS.integrationEvent, (e) => {
      if (!/^post\.(created|updated|deleted)$/.test(e.type)) return;
      const postId = typeof e.data?.post === 'string' ? e.data.post : null;
      if (postId) void this.queue(e.tenantId, postId).catch((err: unknown) => s.log.warn({ err, post: postId }, 'cross-post: could not queue'));
    });
  }

  /** Queues a sync of one post (also called by moderation's hide and restore). */
  async queue(tenantId: string, postId: string, o: { takedown?: boolean; restore?: boolean } = {}): Promise<void> {
    await this.s().jobs.enqueue({ tenantId, type: CROSSPOST_JOB, payload: { tenantId, postId, ...(o.takedown ? { takedown: true } : {}), ...(o.restore ? { restore: true } : {}) } });
  }

  /** Why a post is not (or no longer) in the author's repo; null when it should be. */
  private async reason(post: { state: string; visibility?: string; label: string; author_id: string; tenant_id: string; repost_of?: string | null; body: string | null }, a: PdsAccountRow | null): Promise<string | null> {
    if (post.state !== 'published') return `the post is ${post.state}`;
    if ((post.visibility ?? 'workspace') !== 'public') return `the post is ${post.visibility ?? 'workspace'}, not public`;
    if (post.label !== 'public') return `the post is labelled ${post.label}`;
    if (!post.body) return 'a repost has no text of its own';
    if (!(await this.enabled(post.tenant_id, post.author_id))) return 'the author does not cross-post';
    if (!a || a.state !== 'active') return 'the author has no active account on this PDS';
    return null;
  }

  async sync(tenantId: string, postId: string, mod: 'takedown' | 'restore' | null = null): Promise<{ state: string; reason: string | null }> {
    const s = this.s();
    const post = (await this.db('feed_posts').where({ tenant_id: tenantId, id: postId }).first()) as Record<string, unknown> | undefined;
    if (!post) return { state: 'none', reason: 'no such post' };
    const x = post as unknown as { id: string; tenant_id: string; author_id: string; state: string; visibility?: string; label: string; body: string | null; repost_of: string | null };
    const a = await this.account(tenantId, x.author_id);
    const have = (await this.db('feed_crossposts').where({ tenant_id: tenantId, post_id: postId }).first()) as CrosspostRow | undefined;
    const why = await this.reason(x, a);
    const by: PdsActor = { tenantId, userId: null, actor: { service: 'feed-crosspost' } };
    const t = Date.now();
    const save = async (row: Partial<CrosspostRow>) => {
      if (have) await this.db('feed_crossposts').where({ post_id: postId }).update({ ...row, updated_at: t });
      else await this.db('feed_crossposts').insert({ post_id: postId, tenant_id: tenantId, author_id: x.author_id, account_id: a?.id ?? '', did: a?.did ?? '', rkey: '', uri: '', cid: null, state: 'deleted', reason: null, error: null, ...row, updated_at: t });
    };

    // B-11403: a takedown also labels the record, whether or not it is still there; a restore negates that label.
    if (mod && have?.uri) {
      try {
        if (mod === 'takedown') await s.atproto.emit({ tenantId, userId: null, actor: { service: 'moderation' } }, tenantId, { uri: have.uri, vals: ['!takedown'] });
        else await s.atproto.negate({ tenantId, userId: null, actor: { service: 'moderation' } }, tenantId, { uri: have.uri, val: '!takedown', reason: 'Restored' });
      } catch (err) {
        s.log.warn({ err: (err as Error).message, post: postId }, 'cross-post: takedown label not changed');
      }
    }

    if (why) {
      // not wanted in the repo: remove what was written
      if (have?.state === 'written') {
        const acct = await s.pds.accountById(have.account_id);
        if (acct && acct.state === 'active' && (await s.pds.repo.getRecord(acct, COLLECTION, have.rkey))) await s.pds.repo.applyWrites(by, acct, [{ action: 'delete', collection: COLLECTION, rkey: have.rkey }]);
        await save({ state: 'deleted', cid: null, reason: why, error: null });
        await s.audit.append({ tenantId, action: 'feed.crosspost.deleted', kind: 'system', actor: { service: 'feed-crosspost' }, target: { post: postId, uri: have.uri }, detail: { reason: why } });
        return { state: 'deleted', reason: why };
      }
      // nothing was written: the reason is kept, so the author sees why the post is not in their repo
      await save({ reason: why });
      return { state: have?.state ?? 'deleted', reason: why };
    }

    // wanted: write it (create, or update in place)
    try {
      const value = await this.record(x, a!);
      const exists = have?.state === 'written' && have.account_id === a!.id ? await s.pds.repo.getRecord(a!, COLLECTION, have.rkey) : null;
      const out = await s.pds.repo.applyWrites(by, a!, [exists ? { action: 'update', collection: COLLECTION, rkey: have!.rkey, value } : { action: 'create', collection: COLLECTION, value }], { validate: true });
      const res = out.results[0]!;
      const rkey = res.uri.split('/').pop()!;
      await save({ account_id: a!.id, did: a!.did, rkey, uri: res.uri, cid: res.cid ?? null, state: 'written', reason: null, error: null });
      await s.audit.append({ tenantId, action: exists ? 'feed.crosspost.updated' : 'feed.crosspost.written', kind: 'system', actor: { service: 'feed-crosspost' }, target: { post: postId, uri: res.uri }, label: 'public' });
      return { state: 'written', reason: null };
    } catch (err) {
      const e = err as Error & { detail?: string };
      await save({ state: have?.state === 'written' ? 'written' : 'failed', error: String(e.detail ?? e.message).slice(0, 500) });
      throw err;
    }
  }

  /** The `app.bsky.feed.post` record of a post. */
  private async record(x: { id: string; tenant_id: string; author_id: string; body: string | null }, a: PdsAccountRow): Promise<Record<string, unknown>> {
    const s = this.s();
    const body = x.body ? await s.keys.open(x.tenant_id, x.body, `feed-post:${x.id}`) : '';
    const link = `${s.cfg.PUBLIC_URL.replace(/\/+$/, '')}/#/messages?post=${x.id}`;
    const { text, facets } = textWithFacets(body, link);
    const images = await this.images(x, a);
    const createdAt = new Date(Number(((await this.db('feed_posts').where({ id: x.id }).first('published_at', 'created_at')) as { published_at: number | null; created_at: number }).published_at ?? Date.now())).toISOString();
    return {
      $type: COLLECTION,
      text,
      createdAt,
      ...(facets.length ? { facets } : {}),
      ...(images.length ? { embed: { $type: 'app.bsky.embed.images', images } } : {})
    };
  }

  /** Up to four of the post's images, read as the author and uploaded to their PDS repo as blobs. */
  private async images(x: { id: string; tenant_id: string; author_id: string }, a: PdsAccountRow) {
    const s = this.s();
    const media = (await this.db('feed_post_media as m').join('files as f', 'f.id', 'm.file_id').where({ 'm.post_id': x.id }).whereNull('f.trashed_at').where('f.state', 'ready').orderBy('m.position').select('f.id', 'f.name')) as { id: string; name: string }[];
    if (!media.length) return [];
    const author = await loadPrincipal(s, x.tenant_id, x.author_id, {});
    if (!author) return [];
    const out: Record<string, unknown>[] = [];
    for (const f of media) {
      if (out.length >= MAX_IMAGES) break;
      const r = await s.files.content(author, f.id).catch(() => null);
      if (!r || !/^image\/(png|jpeg|webp|gif)$/.test(r.version.type ?? '') || r.version.label !== 'public' || Number(r.version.size) > IMAGE_MAX_BYTES) continue;
      // 1.8.0 (B-142): the picture leaves without its metadata (EXIF, GPS), with the alt text written for it if any.
      const parts: Buffer[] = [];
      for await (const c of r.stream) parts.push(c);
      let data: Buffer;
      try {
        data = await stripBuffer(r.version.type, Buffer.concat(parts));
      } catch {
        continue;
      }
      const blob = await s.pds.blobs.upload({ tenantId: x.tenant_id, userId: x.author_id, actor: { service: 'feed-crosspost' } }, a, (async function* () { yield data; })(), { declaredBytes: data.length });
      const alt = (await s.files.metaFor([f.id])).get(f.id)?.alt_text;
      out.push({ image: dataToJson(blob as never), alt: (alt || f.name.replace(/\.[A-Za-z0-9]{1,5}$/, '')).slice(0, 1000) });
    }
    return out;
  }
}
