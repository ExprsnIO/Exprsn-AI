import { ulid } from 'ulid';
import { clears, highest, labelRank, type Label } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import { randomToken } from '../crypto/index.js';
import { loadPrincipal } from '../http/middleware.js';
import { conflict, forbidden, HttpProblem, notFound, tooManyRequests } from '../http/problem.js';
import { burnPasswordCheck, hashPassword, verifyPassword } from '../identity/passwords.js';
import { Limiter } from '../platform/ratelimit.js';
import type { Services } from '../services.js';
import { ipRange } from '../spam/signals.js';
import { mac, macMatches, macs } from '../vault/keyring.js';
import type { Albums, AlbumRow, AuditCtx, VisibleItem } from './albums.js';
import type { FileService } from './service.js';

/*
 * 1.9.0, Sprint 53 (B-178): album share links and upload links.
 *
 * Share links. A link to an album for people without an account, on the rules of anonymous file links (B-706): the
 * tenant's anonymous-link setting must be on, the album's floor must be `public`, the link expires within the tenant's
 * maximum, and its reader has the clearance `public`, so only public items are ever shown (through the album's access
 * rule, `Albums.visibleItems`). A link may carry a password (argon2id; attempts limited per link and address range,
 * ALBUM_PASSWORD_ATTEMPTS in a quarter of an hour) and is `view` (the grid and slideshow, previews and the cleaned
 * images inline) or `download` (also each item and the whole album as a zip). The token is shown once and kept as an
 * HMAC under the `link` key; it travels in POST bodies, never in a URL. Opening a link mints short-lived signed media
 * addresses for the items (`media`), the way artifact renders are reached. Revoked links, deleted albums, an album whose
 * floor is no longer public and a tenant that turned anonymous links off all answer the same 404. Each open and each
 * download is audited (`album.share.viewed`, `album.share.downloaded`) with the address, as file links are; nothing more
 * about the reader is kept.
 *
 * Upload links. A link that lets people without an account add photos and videos: expiry, a maximum number of files
 * and a maximum size per file (within FILES_MAX_BYTES and the storage quotas, which still apply), and the uploader's
 * name, asked and stored as given (sealed). Each upload is a file of the link's creator in the album's workspace (or a
 * folder of it), labelled with the album's label, and goes through the file store's quarantine and scan like any other;
 * it is held (`scanning`) until the scan passes, then added to the album, or `rejected` with the scanner's reason. The
 * owner and editors see pending and rejected uploads. Uploads are counted per address and per link, and recorded with
 * the spam and flood signals (`s.spam.record`, surface `post`, the link as the account and the address range).
 *
 * Audit: `album.share.*` and `album.upload.*`. Until migration 136 is applied, links report as not available.
 */

export type ShareMode = 'view' | 'download';

export interface ShareLinkRow {
  id: string;
  tenant_id: string;
  album_id: string;
  token_hash: string;
  mode: ShareMode;
  password_hash: string | null;
  expires_at: number;
  views: number;
  downloads: number;
  last_used_at: number | null;
  created_by: string;
  created_at: number;
  revoked_at: number | null;
  revoked_by: string | null;
}

export interface UploadLinkRow {
  id: string;
  tenant_id: string;
  album_id: string;
  token_hash: string;
  workspace_id: string;
  folder_id: string | null;
  expires_at: number;
  max_files: number;
  max_bytes: number;
  files_received: number;
  created_by: string;
  created_at: number;
  revoked_at: number | null;
  revoked_by: string | null;
}

export interface PendingUploadRow {
  id: string;
  tenant_id: string;
  album_id: string;
  link_id: string;
  file_id: string;
  name: string;
  size: number;
  uploader_name: string;
  state: 'scanning' | 'added' | 'rejected';
  reason: string | null;
  created_at: number;
  settled_at: number | null;
}

export const SHARE_TOKEN = /^exa_[A-Za-z0-9_-]{20,100}$/;
export const UPLOAD_TOKEN = /^exu_[A-Za-z0-9_-]{20,100}$/;
/** Password attempts per link and address range in 15 minutes. */
export const ALBUM_PASSWORD_ATTEMPTS = 10;
/** How long a media address minted by an open stays good. */
export const MEDIA_TTL_MS = 15 * 60_000;
export const UPLOAD_LIMITS = { maxFiles: 500, maxHours: 30 * 24 };

const num = (v: unknown): number | null => (v == null ? null : Number(v));
const shareFrom = (r: Record<string, unknown>): ShareLinkRow => ({ ...(r as unknown as ShareLinkRow), expires_at: Number(r.expires_at), views: Number(r.views ?? 0), downloads: Number(r.downloads ?? 0), last_used_at: num(r.last_used_at), created_at: Number(r.created_at), revoked_at: num(r.revoked_at) });
const uploadFrom = (r: Record<string, unknown>): UploadLinkRow => ({ ...(r as unknown as UploadLinkRow), expires_at: Number(r.expires_at), max_files: Number(r.max_files), max_bytes: Number(r.max_bytes), files_received: Number(r.files_received ?? 0), created_at: Number(r.created_at), revoked_at: num(r.revoked_at) });
const pendingFrom = (r: Record<string, unknown>): PendingUploadRow => ({ ...(r as unknown as PendingUploadRow), size: Number(r.size ?? 0), created_at: Number(r.created_at), settled_at: num(r.settled_at) });

const stateOf = (x: { revoked_at: number | null; expires_at: number }, full = false) => (x.revoked_at != null ? 'revoked' : x.expires_at <= Date.now() ? 'expired' : full ? 'full' : 'active');
export const shareLinkView = (x: ShareLinkRow) => ({ id: x.id, albumId: x.album_id, mode: x.mode, password: !!x.password_hash, expiresAt: x.expires_at, views: x.views, downloads: x.downloads, lastUsedAt: x.last_used_at, createdBy: x.created_by, createdAt: x.created_at, revokedAt: x.revoked_at, state: stateOf(x) });
export const uploadLinkView = (x: UploadLinkRow) => ({ id: x.id, albumId: x.album_id, workspaceId: x.workspace_id, folderId: x.folder_id, expiresAt: x.expires_at, maxFiles: x.max_files, maxBytes: x.max_bytes, received: x.files_received, remaining: Math.max(0, x.max_files - x.files_received), createdBy: x.created_by, createdAt: x.created_at, revokedAt: x.revoked_at, state: stateOf(x, x.files_received >= x.max_files) });

const linksNotAvailable = () => new HttpProblem(503, 'Album links not available', 'Album share and upload links need migration 136_album_links, which this database does not have yet. Ask an operator to run the migrations.', { extensions: { step: 'schema', migration: '136_album_links' } });
const gone = () => notFound('Shared album');
const uploadGone = () => notFound('Upload link');

export class AlbumLinks {
  private schema: { ok: boolean; at: number } | null = null;
  private passwordLimiter: Limiter | null = null;

  constructor(
    private readonly s: () => Services,
    private readonly albums: Albums,
    private readonly fs: FileService
  ) {}

  private get db() {
    return this.s().db;
  }

  private get pwLimiter(): Limiter {
    this.passwordLimiter ??= new Limiter(this.s().counters, 'album-link-password', ALBUM_PASSWORD_ATTEMPTS, 15 * 60_000);
    return this.passwordLimiter;
  }

  async available(): Promise<boolean> {
    if (!(await this.albums.available())) return false;
    const t = Date.now();
    if (this.schema && (this.schema.ok || t - this.schema.at < 30_000)) return this.schema.ok;
    let ok: boolean;
    try {
      ok = (await this.db.schema.hasTable('album_share_links')) && (await this.db.schema.hasTable('album_upload_links')) && (await this.db.schema.hasTable('album_pending_uploads'));
    } catch {
      ok = false;
    }
    this.schema = { ok, at: t };
    return ok;
  }

  resetSchemaCache(): void {
    this.schema = null;
  }

  private async need(): Promise<void> {
    if (!(await this.available())) throw linksNotAvailable();
  }

  private key() {
    return this.s().sysKeys.key('link');
  }

  // ---------- share links: managing ----------

  async createShare(p: Principal, ctx: AuditCtx, albumId: string, input: { mode: ShareMode; expiresInHours: number; password?: string | null }) {
    await this.need();
    const acc = await this.albums.require(p, albumId, 'editor');
    const a = acc.album;
    const set = await this.s().sharing.settings(p.tenantId);
    if (!set.anonymousLinks) throw forbidden('Links that work without signing in are turned off for this tenant. A tenant admin can turn them on (Sharing settings).', { step: 'policy' });
    if (a.label !== 'public') throw forbidden(`Only an album labelled public can have a share link; this one is ${a.label}. Its readers see public items only.`, { step: 'label' });
    if (input.expiresInHours > set.anonymousMaxHours) throw new HttpProblem(400, 'Invalid request', `Links that work without signing in expire within ${set.anonymousMaxHours} hours in this tenant.`);
    const token = `exa_${randomToken(32)}`;
    const t = Date.now();
    const row: ShareLinkRow = { id: ulid(), tenant_id: p.tenantId, album_id: a.id, token_hash: mac(this.key(), `album-link:${token}`), mode: input.mode, password_hash: input.password ? await hashPassword(input.password) : null, expires_at: t + input.expiresInHours * 3_600_000, views: 0, downloads: 0, last_used_at: null, created_by: p.userId, created_at: t, revoked_at: null, revoked_by: null };
    await this.db('album_share_links').insert(row);
    await this.albums.audit(p, ctx, p.tenantId, 'album.share.created', { album: a.id, link: row.id }, 'public', { mode: row.mode, password: !!row.password_hash, expiresAt: row.expires_at });
    return { ...shareLinkView(row), token };
  }

  async shares(p: Principal, albumId: string) {
    await this.need();
    const acc = await this.albums.require(p, albumId, 'editor');
    return ((await this.db('album_share_links').where({ tenant_id: p.tenantId, album_id: acc.album.id }).orderBy('created_at', 'desc')) as Record<string, unknown>[]).map(shareFrom).map(shareLinkView);
  }

  async revokeShare(p: Principal, ctx: AuditCtx, albumId: string, linkId: string) {
    await this.need();
    const acc = await this.albums.require(p, albumId, 'editor');
    const r = await this.db('album_share_links').where({ tenant_id: p.tenantId, album_id: acc.album.id, id: linkId }).first();
    if (!r) throw notFound('Share link');
    const x = shareFrom(r);
    if (x.revoked_at == null) {
      await this.db('album_share_links').where({ id: x.id }).update({ revoked_at: Date.now(), revoked_by: p.userId });
      await this.albums.audit(p, ctx, p.tenantId, 'album.share.revoked', { album: acc.album.id, link: x.id }, 'public', { mode: x.mode });
    }
  }

  // ---------- share links: using ----------

  private async shareRow(token: string): Promise<ShareLinkRow | null> {
    const r = await this.db('album_share_links').whereIn('token_hash', macs(this.key(), `album-link:${token}`)).first();
    return r ? shareFrom(r) : null;
  }

  /** The live link and its album, or the same 404 for every refusal. */
  private async liveShare(token: string): Promise<{ link: ShareLinkRow; album: AlbumRow }> {
    if (!(await this.available())) throw gone();
    const x = await this.shareRow(token);
    if (!x || x.revoked_at != null || x.expires_at <= Date.now()) throw gone();
    const a = await this.albums.row(x.tenant_id, x.album_id);
    if (!a || a.deleted_at != null || a.label !== 'public') throw gone();
    const s = this.s();
    if (!(await s.sharing.settings(x.tenant_id)).anonymousLinks) throw gone();
    const tenant = await s.tenants.byId(x.tenant_id);
    if (!tenant || tenant.state !== 'active') throw gone();
    return { link: x, album: a };
  }

  /** Checks the link's password (when it has one) within the attempt limit; refusals name the problem. */
  private async checkPassword(link: ShareLinkRow, password: string | null | undefined, ip: string | null, ctx: AuditCtx): Promise<void> {
    if (!link.password_hash) return;
    if (!password) throw new HttpProblem(401, 'Password required', 'This album is protected by a password. Ask the person who shared it.', { extensions: { passwordRequired: true } });
    const l = await this.pwLimiter.consume(`${link.id}:${ipRange(ip) ?? 'unknown'}`);
    if (!l.allowed) {
      await burnPasswordCheck(password);
      throw tooManyRequests('Too many wrong passwords for this album from this address; try again later.', Math.ceil(l.resetMs / 1000));
    }
    if (!(await verifyPassword(link.password_hash, password))) {
      await this.albums.audit(null, ctx, link.tenant_id, 'album.share.password_failed', { album: link.album_id, link: link.id }, 'public');
      throw new HttpProblem(401, 'Wrong password', 'That password does not open this album.', { extensions: { passwordRequired: true } });
    }
  }

  private publicItems(a: AlbumRow): Promise<VisibleItem[]> {
    return this.albums.visibleItems({ anonymous: true }, { album: a, ceiling: 'public' });
  }

  /** A signed media address for one item of one link: `<link>.<file>.<kind>.<expiry>.<mac>`. */
  private mediaToken(linkId: string, fileId: string, kind: 'preview' | 'full' | 'download', exp: number): string {
    const body = `${linkId}.${fileId}.${kind}.${exp}`;
    return `${body}.${mac(this.key(), `album-media:${body}`).slice(0, 43)}`;
  }

  /** Opens a link: the album as anonymous readers see it (public items only), with media addresses. Audited. */
  async open(token: string, password: string | null | undefined, ctx: AuditCtx) {
    const { link, album } = await this.liveShare(token);
    await this.checkPassword(link, password, ctx.ip, ctx);
    const visible = await this.publicItems(album);
    const exp = Date.now() + MEDIA_TTL_MS;
    const meta = await this.fs.metaFor(visible.map((v) => v.file.id));
    await this.db('album_share_links').where({ id: link.id }).update({ views: this.db.raw('?? + 1', ['views']), last_used_at: Date.now() });
    await this.albums.audit(null, ctx, link.tenant_id, 'album.share.viewed', { album: album.id, link: link.id }, 'public', { items: visible.length, mode: link.mode });
    const cover = visible.find((v) => v.file.id === album.cover_file_id) ?? visible[0] ?? null;
    const url = (fid: string, kind: 'preview' | 'full' | 'download') => `/api/public/album-links/media/${this.mediaToken(link.id, fid, kind, exp)}`;
    return {
      title: album.title,
      description: album.description,
      label: 'public' as Label,
      mode: link.mode,
      expiresAt: link.expires_at,
      mediaExpiresAt: exp,
      coverItemId: cover?.item.id ?? null,
      items: visible.map((v) => ({
        id: v.item.id,
        name: v.file.name,
        type: v.file.type,
        kind: v.file.type && v.file.type.startsWith('video/') ? 'video' : 'image',
        size: v.file.size,
        altText: meta.get(v.file.id)?.alt_text ?? null,
        description: meta.get(v.file.id)?.description ?? null,
        preview: url(v.file.id, 'preview'),
        full: url(v.file.id, 'full'),
        ...(link.mode === 'download' ? { download: url(v.file.id, 'download') } : {})
      }))
    };
  }

  /**
   * One item through a media address minted by `open`: checked again against the link and the album's access rule
   * (public items only). `preview` is the stored preview (else the cleaned image), `full` the cleaned copy inline,
   * `download` (download links only) the cleaned copy as an attachment, audited.
   */
  async media(cap: string, ctx: AuditCtx): Promise<{ kind: 'preview' | 'full' | 'download'; name: string; type: string; data?: Buffer; stream?: AsyncIterable<Buffer>; size: number | null }> {
    if (!(await this.available())) throw gone();
    const m = /^([0-9A-Z]{26})\.([0-9A-Z]{26})\.(preview|full|download)\.(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(cap);
    if (!m) throw gone();
    const [, linkId, fileId, kind, expS, sig] = m as unknown as [string, string, string, 'preview' | 'full' | 'download', string, string];
    if (Number(expS) <= Date.now() || !macMatches(this.key(), `album-media:${linkId}.${fileId}.${kind}.${expS}`, sig, 43)) throw gone();
    const r = await this.db('album_share_links').where({ id: linkId }).first();
    if (!r) throw gone();
    const link = shareFrom(r);
    if (link.revoked_at != null || link.expires_at <= Date.now()) throw gone();
    if (kind === 'download' && link.mode !== 'download') throw gone();
    const a = await this.albums.row(link.tenant_id, link.album_id);
    if (!a || a.deleted_at != null || a.label !== 'public' || !(await this.s().sharing.settings(link.tenant_id)).anonymousLinks) throw gone();
    const hit = (await this.publicItems(a)).find((v) => v.file.id === fileId);
    if (!hit) throw gone();
    if (kind === 'preview' && hit.file.type && !hit.file.type.startsWith('video/')) {
      const pv = await this.fs.previewCurrent(a.tenant_id, fileId);
      if (pv) return { kind, name: hit.file.name, type: pv.type, data: pv.data, size: pv.data.length };
    }
    const got = await this.fs.servedCurrent(a.tenant_id, fileId);
    if (!got) throw gone();
    if (kind === 'download') {
      await this.db('album_share_links').where({ id: link.id }).update({ downloads: this.db.raw('?? + 1', ['downloads']), last_used_at: Date.now() });
      await this.albums.audit(null, ctx, link.tenant_id, 'album.share.downloaded', { album: a.id, link: link.id, file: fileId }, 'public', { what: 'item' });
    }
    return { kind, name: hit.file.name, type: got.version.type ?? 'application/octet-stream', stream: got.stream, size: got.size };
  }

  /** The whole album as a zip, for a download link. Audited. */
  async downloadZip(token: string, password: string | null | undefined, ctx: AuditCtx): Promise<{ name: string; stream: AsyncGenerator<Buffer> }> {
    const { link, album } = await this.liveShare(token);
    await this.checkPassword(link, password, ctx.ip, ctx);
    if (link.mode !== 'download') throw forbidden('This link is for viewing only.', { step: 'link-mode' });
    const visible = await this.publicItems(album);
    if (!visible.length) throw conflict('There is nothing in this album to download.');
    await this.db('album_share_links').where({ id: link.id }).update({ downloads: this.db.raw('?? + 1', ['downloads']), last_used_at: Date.now() });
    await this.albums.audit(null, ctx, link.tenant_id, 'album.share.downloaded', { album: album.id, link: link.id }, 'public', { what: 'zip', items: visible.length });
    return { name: `${album.title}.zip`, stream: this.albums.zipOf(visible) };
  }

  // ---------- upload links: managing ----------

  /** The album's label as uploads take it, checked against where they land and the creator's clearance. */
  private async uploadLabel(a: AlbumRow, creator: Principal, workspaceId: string): Promise<Label> {
    const fresh = (await this.albums.relabel(a.id)) ?? a;
    const label = fresh.effective_label;
    const ws = await this.s().tenants.workspace(a.tenant_id, workspaceId);
    if (!ws) throw notFound('Workspace');
    if (!clears(creator.clearance, label)) throw forbidden(`The album is ${label}, above the clearance of the link's creator (${creator.clearance}).`, { step: 'clearance' });
    if (labelRank(label) > labelRank(ws.label_ceiling)) throw forbidden(`${ws.name}'s ceiling is ${ws.label_ceiling}; uploads take the album's label, ${label}.`, { step: 'zone' });
    return label;
  }

  async createUpload(p: Principal, ctx: AuditCtx, albumId: string, input: { expiresInHours: number; maxFiles: number; maxBytes?: number | null; folderId?: string | null }) {
    await this.need();
    const acc = await this.albums.require(p, albumId, 'editor');
    const a = acc.album;
    const w = await this.fs.workspaceFor(p, a.workspace_id).catch(() => {
      throw forbidden('Upload links put files in the album\'s workspace; you are not a member of it.', { step: 'workspace' });
    });
    let folderId: string | null = null;
    if (input.folderId) {
      const f = await this.fs.folder(p, input.folderId);
      if (f.workspace_id !== w.id) throw conflict('Choose a folder in the album\'s workspace.');
      folderId = f.id;
    }
    const cap = this.fs.options.maxBytes;
    const maxBytes = Math.min(input.maxBytes ?? cap, cap);
    const label = await this.uploadLabel(a, p, w.id);
    const token = `exu_${randomToken(32)}`;
    const t = Date.now();
    const row: UploadLinkRow = { id: ulid(), tenant_id: p.tenantId, album_id: a.id, token_hash: mac(this.key(), `album-upload:${token}`), workspace_id: w.id, folder_id: folderId, expires_at: t + input.expiresInHours * 3_600_000, max_files: input.maxFiles, max_bytes: maxBytes, files_received: 0, created_by: p.userId, created_at: t, revoked_at: null, revoked_by: null };
    await this.db('album_upload_links').insert(row);
    await this.albums.audit(p, ctx, p.tenantId, 'album.upload.link_created', { album: a.id, link: row.id, workspace: w.id }, label, { maxFiles: row.max_files, maxBytes: row.max_bytes, expiresAt: row.expires_at, ...(folderId ? { folder: folderId } : {}) });
    return { ...uploadLinkView(row), token };
  }

  async uploadLinks(p: Principal, albumId: string) {
    await this.need();
    const acc = await this.albums.require(p, albumId, 'editor');
    return ((await this.db('album_upload_links').where({ tenant_id: p.tenantId, album_id: acc.album.id }).orderBy('created_at', 'desc')) as Record<string, unknown>[]).map(uploadFrom).map(uploadLinkView);
  }

  async revokeUpload(p: Principal, ctx: AuditCtx, albumId: string, linkId: string) {
    await this.need();
    const acc = await this.albums.require(p, albumId, 'editor');
    const r = await this.db('album_upload_links').where({ tenant_id: p.tenantId, album_id: acc.album.id, id: linkId }).first();
    if (!r) throw notFound('Upload link');
    const x = uploadFrom(r);
    if (x.revoked_at == null) {
      await this.db('album_upload_links').where({ id: x.id }).update({ revoked_at: Date.now(), revoked_by: p.userId });
      await this.albums.audit(p, ctx, p.tenantId, 'album.upload.link_revoked', { album: acc.album.id, link: x.id }, acc.album.effective_label, { received: x.files_received });
    }
  }

  /** What came in through the album's upload links: scanning, added and rejected, with the names given. */
  async uploads(p: Principal, albumId: string) {
    await this.need();
    const acc = await this.albums.require(p, albumId, 'editor');
    await this.reconcile(acc.album.tenant_id, acc.album.id);
    const rows = ((await this.db('album_pending_uploads').where({ tenant_id: p.tenantId, album_id: acc.album.id }).orderBy('created_at', 'desc').limit(500)) as Record<string, unknown>[]).map(pendingFrom);
    const out = [];
    for (const r of rows) out.push({ id: r.id, linkId: r.link_id, fileId: r.file_id, name: r.name, size: r.size, uploaderName: await this.s().keys.open(r.tenant_id, r.uploader_name, `album-upload:${r.id}`).catch(() => null), state: r.state, reason: r.reason, createdAt: r.created_at, settledAt: r.settled_at });
    return out;
  }

  // ---------- upload links: using ----------

  private async uploadRow(token: string): Promise<UploadLinkRow | null> {
    const r = await this.db('album_upload_links').whereIn('token_hash', macs(this.key(), `album-upload:${token}`)).first();
    return r ? uploadFrom(r) : null;
  }

  private async liveUpload(token: string): Promise<{ link: UploadLinkRow; album: AlbumRow }> {
    if (!(await this.available())) throw uploadGone();
    const x = await this.uploadRow(token);
    if (!x || x.revoked_at != null || x.expires_at <= Date.now()) throw uploadGone();
    const a = await this.albums.row(x.tenant_id, x.album_id);
    if (!a || a.deleted_at != null) throw uploadGone();
    const tenant = await this.s().tenants.byId(x.tenant_id);
    if (!tenant || tenant.state !== 'active') throw uploadGone();
    return { link: x, album: a };
  }

  /** What an uploader is told before they send anything: the album's title and the link's limits. */
  async openUpload(token: string) {
    const { link, album } = await this.liveUpload(token);
    return { albumTitle: album.title, maxFiles: link.max_files, maxBytes: link.max_bytes, remaining: Math.max(0, link.max_files - link.files_received), expiresAt: link.expires_at };
  }

  /**
   * Receives one upload: a place is taken atomically (refused when the link is full), the spam signals are recorded,
   * the bytes stream into the file store's quarantine as a file of the link's creator, capped at the link's size, and a
   * pending row waits for the scan. Audited with the address, as anonymous file links are.
   */
  async receive(token: string, input: { name: string; uploader: string; declaredType: string | null; declaredBytes: number | null }, body: AsyncIterable<Buffer | Uint8Array>, ctx: AuditCtx) {
    const s = this.s();
    const { link, album } = await this.liveUpload(token);
    s.spam.record({ tenantId: link.tenant_id, surface: 'post', account: `album-upload:${link.id}`, ip: ctx.ip, recipient: `album:${album.id}`, text: input.uploader });
    if (input.declaredBytes != null && input.declaredBytes > link.max_bytes) throw new HttpProblem(413, 'Payload too large', `This link takes files up to ${link.max_bytes.toLocaleString('en-US')} bytes.`, { extensions: { cap: 'link', max: link.max_bytes } });
    const now = Date.now();
    const took = await this.db('album_upload_links').where({ id: link.id }).whereNull('revoked_at').andWhere('expires_at', '>', now).andWhere('files_received', '<', this.db.ref('max_files')).update({ files_received: this.db.raw('?? + 1', ['files_received']) });
    if (!took) throw new HttpProblem(409, 'Upload link full', 'This link has taken all the files it allows.', { extensions: { remaining: 0 } });
    const release = () => this.db('album_upload_links').where({ id: link.id }).andWhere('files_received', '>', 0).update({ files_received: this.db.raw('?? - 1', ['files_received']) });
    try {
      const creator = await loadPrincipal(s, link.tenant_id, link.created_by, {});
      if (!creator) throw uploadGone();
      const label = await this.uploadLabel(album, creator, link.workspace_id);
      const max = link.max_bytes;
      let seen = 0;
      const capped = async function* (): AsyncGenerator<Buffer> {
        for await (const c of body) {
          const b = Buffer.isBuffer(c) ? c : Buffer.from(c.buffer, c.byteOffset, c.byteLength);
          seen += b.length;
          if (seen > max) throw new HttpProblem(413, 'Payload too large', `This link takes files up to ${max.toLocaleString('en-US')} bytes.`, { extensions: { cap: 'link', max } });
          yield b;
        }
      };
      const name = await this.fs.freeName(link.tenant_id, link.workspace_id, link.folder_id, input.name);
      const { file, version } = await this.fs.upload({ ...creator, workspaceId: link.workspace_id }, { workspaceId: link.workspace_id, folderId: link.folder_id, name, label, declaredType: input.declaredType, declaredBytes: input.declaredBytes }, capped());
      const id = ulid();
      const row: PendingUploadRow = { id, tenant_id: link.tenant_id, album_id: album.id, link_id: link.id, file_id: file.id, name, size: version.size, uploader_name: await s.keys.seal(link.tenant_id, input.uploader, `album-upload:${id}`), state: 'scanning', reason: null, created_at: Date.now(), settled_at: null };
      await this.db('album_pending_uploads').insert(row);
      await this.albums.audit(null, ctx, link.tenant_id, 'album.upload.received', { album: album.id, link: link.id, upload: id, file: file.id }, label, { name, size: version.size, sha256: version.sha256 });
      // A scan that already finished (an instance that runs jobs inline) is settled now.
      await this.reconcile(link.tenant_id, album.id);
      const settled = pendingFrom((await this.db('album_pending_uploads').where({ id }).first()) as Record<string, unknown>);
      return { id, name, size: version.size, state: settled.state, ...(settled.reason ? { reason: settled.reason } : {}) };
    } catch (err) {
      await release();
      throw err;
    }
  }

  /** The file store's scan finished a version (`FileService.settledListeners`): settles the upload that made it. */
  async onSettled(e: { tenantId: string; fileId: string; state: 'ready' | 'rejected'; reason?: string }): Promise<void> {
    if (!(await this.available())) return;
    const rows = ((await this.db('album_pending_uploads').where({ tenant_id: e.tenantId, file_id: e.fileId, state: 'scanning' })) as Record<string, unknown>[]).map(pendingFrom);
    for (const r of rows) await this.settle(r, e.state, e.reason ?? null);
  }

  /** Settles uploads whose scan finished (also run when the owner looks, in case a notice was missed). */
  async reconcile(tenantId: string, albumId: string): Promise<void> {
    const rows = ((await this.db('album_pending_uploads as u').join('files as f', 'f.id', 'u.file_id').where({ 'u.tenant_id': tenantId, 'u.album_id': albumId, 'u.state': 'scanning' }).whereIn('f.state', ['ready', 'rejected']).select('u.*', 'f.state as file_state')) as Record<string, unknown>[]);
    for (const r of rows) await this.settle(pendingFrom(r), r.file_state === 'ready' ? 'ready' : 'rejected', null);
    // A file gone (deleted while scanning) is a rejection too.
    const orphans = ((await this.db('album_pending_uploads as u').leftJoin('files as f', 'f.id', 'u.file_id').where({ 'u.tenant_id': tenantId, 'u.album_id': albumId, 'u.state': 'scanning' }).whereNull('f.id').select('u.*')) as Record<string, unknown>[]).map(pendingFrom);
    for (const r of orphans) await this.settle(r, 'rejected', 'The file is gone.');
  }

  private async settle(r: PendingUploadRow, state: 'ready' | 'rejected', reason: string | null): Promise<void> {
    const a = await this.albums.row(r.tenant_id, r.album_id);
    let next: 'added' | 'rejected' = 'rejected';
    let why = reason;
    if (state === 'ready' && a) {
      const link = uploadFrom((await this.db('album_upload_links').where({ id: r.link_id }).first()) as Record<string, unknown>);
      const out = await this.albums.addUploaded(a, r.file_id, link.created_by);
      next = out.added ? 'added' : 'rejected';
      why = out.reason ?? null;
    } else if (state === 'rejected' && !why) {
      const v = (await this.db('file_versions').where({ file_id: r.file_id }).orderBy('number', 'desc').first('reason')) as { reason: string | null } | undefined;
      why = v?.reason ?? 'Rejected by the scan.';
    }
    const n = await this.db('album_pending_uploads').where({ id: r.id, state: 'scanning' }).update({ state: next, reason: why ? why.slice(0, 500) : null, settled_at: Date.now() });
    if (!n) return;
    const label: Label = a ? highest(a.label, a.effective_label) : 'internal';
    await this.albums.audit(null, { ip: null }, r.tenant_id, next === 'added' ? 'album.upload.added' : 'album.upload.rejected', { album: r.album_id, link: r.link_id, upload: r.id, file: r.file_id }, label, { name: r.name, ...(why ? { reason: why } : {}) });
  }
}
