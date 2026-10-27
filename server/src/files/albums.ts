import { ulid } from 'ulid';
import { actorFrom } from '../audit/chain.js';
import { clears, highest, isLabel, labelRank, type Label } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import { can } from '../groups/roles.js';
import { loadPrincipal, workspacesFor } from '../http/middleware.js';
import { conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import { zipStream, type ZipStreamMember } from '../platform/zip-writer.js';
import type { Services } from '../services.js';
import { AlbumLinks } from './album-links.js';
import { IMAGE_TYPES } from './scan.js';
import type { FileService } from './service.js';

/*
 * 1.9.0, Sprint 53 (B-177, B-179): albums on Files.
 *
 * An album is an ordered set of files (images, and videos once the file store reads them) with a title, a description
 * and a cover. The items stay files: they are uploaded, versioned, scanned, labelled, stripped of their metadata when
 * served (B-142) and described with alt text in the file store as before; an album only points at them.
 *
 * Kinds and audience. A `workspace` album is seen by the members of its workspace, a `group` album by whoever counts
 * as a member of its group now (`s.groups.subjects`), a `personal` album by its owner and the people it names. Each
 * person may also hold a role: `viewer`, `contributor` (adds their own items, removes their own) or `editor` (orders,
 * removes any item, edits the details and the cover, manages viewers and contributors); the owner does everything and
 * manages editors. A group's moderators act as editors of its albums. In a workspace or group album a role is only
 * held while the person is also in that audience: a role never reaches outside the workspace or group.
 *
 * Labels. `label` is the floor the owner gives the title and description (within the audience's ceiling and their
 * clearance); the album's `effective_label` is the high-water mark of the floor and its items' labels, kept as items
 * come and go and re-read on every open. A person sees the album when they are cleared for its floor, and each item
 * only when cleared for that item's label: an item above someone's clearance is never shown to them, nor counted.
 *
 * Access (the rule, `itemVisible`). Being in an album does not widen who may read a file. An item is shown to a person
 * only when all of these hold now: they are in the album's audience; the file is ready, not in the trash and not taken
 * down; they are cleared for its current label and the label fits the audience's ceiling (the workspace's ceiling, the
 * group's label); and either they can read the file through its own access (its workspace, a share, a group grant), or
 * the person who added it could share it with them now: adding takes the right to change the file (a member of its
 * workspace cleared for its label, what a file share takes), and that is checked again on every read, so the album's
 * grant is never more than a share the adder could have made, and it ends when they lose the file. Anonymous share
 * links (B-178) read through the same rule with the clearance `public`.
 *
 * Audit: `album.*` for every change, download and post. B-179: posting to the feed (a post whose source is the album)
 * and a batched `album` notification to the people in the album when items are added.
 *
 * Until migration 135 is applied, `available()` is false: lists answer `available: false` and the rest 503.
 */

export type AlbumKind = 'personal' | 'group' | 'workspace';
export const ALBUM_KINDS = ['personal', 'group', 'workspace'] as const;
export type AlbumRole = 'viewer' | 'contributor' | 'editor';
export const ALBUM_ROLES = ['viewer', 'contributor', 'editor'] as const;
export type Standing = AlbumRole | 'owner';

const RANK: Record<Standing, number> = { viewer: 0, contributor: 1, editor: 2, owner: 3 };
/** Videos the album shows when the file store has accepted them; today the scan reads only the image types. */
export const VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime'];
export const isAlbumMedia = (type: string | null | undefined): boolean => !!type && (IMAGE_TYPES.includes(type) || VIDEO_TYPES.includes(type));
export const ALBUM_LIMITS = { items: 2000, addPerCall: 100, zipItems: 1000, title: 200, description: 4000, contributors: 500 };

export interface AlbumRow {
  id: string;
  tenant_id: string;
  kind: AlbumKind;
  owner_id: string;
  workspace_id: string;
  group_id: string | null;
  title: string;
  description: string | null;
  label: Label;
  effective_label: Label;
  cover_file_id: string | null;
  item_count: number;
  notified_at: number | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface AlbumItemRow {
  id: string;
  tenant_id: string;
  album_id: string;
  file_id: string;
  position: number;
  added_by: string;
  added_at: number;
}

export interface ContributorRow {
  album_id: string;
  tenant_id: string;
  user_id: string;
  role: AlbumRole;
  added_by: string;
  added_at: number;
}

/** The file columns an album reads. */
export interface ItemFile {
  id: string;
  tenant_id: string;
  workspace_id: string;
  owner_id: string;
  name: string;
  label: Label;
  state: string;
  type: string | null;
  size: number;
  current_version: number | null;
  trashed_at: number | null;
  taken_down_at: number | null;
}

export interface Access {
  album: AlbumRow;
  standing: Standing | null;
  /** In the album's audience now. */
  member: boolean;
  /** Cleared for the album's floor. */
  cleared: boolean;
  /** The highest label the audience may see. */
  ceiling: Label;
}

/** Who reads: a signed-in person, or an anonymous share link (clearance public). */
export type Reader = { p: Principal } | { anonymous: true };

export interface VisibleItem {
  item: AlbumItemRow;
  file: ItemFile;
}

const num = (v: unknown): number | null => (v == null ? null : Number(v));
const labelOf = (v: unknown): Label => (isLabel(v) ? v : 'restricted');
export const albumFrom = (r: Record<string, unknown>): AlbumRow => ({ ...(r as unknown as AlbumRow), label: labelOf(r.label), effective_label: labelOf(r.effective_label), item_count: Number(r.item_count ?? 0), notified_at: num(r.notified_at), created_at: Number(r.created_at), updated_at: Number(r.updated_at), deleted_at: num(r.deleted_at) });
const itemFrom = (r: Record<string, unknown>): AlbumItemRow => ({ ...(r as unknown as AlbumItemRow), position: Number(r.position), added_at: Number(r.added_at) });
const fileFrom = (r: Record<string, unknown>): ItemFile => ({ ...(r as unknown as ItemFile), label: labelOf(r.label), size: Number(r.size ?? 0), current_version: num(r.current_version), trashed_at: num(r.trashed_at), taken_down_at: num(r.taken_down_at) });
const FILE_COLS = ['id', 'tenant_id', 'workspace_id', 'owner_id', 'name', 'label', 'state', 'type', 'size', 'current_version', 'trashed_at', 'taken_down_at'];

export const notAvailable = () => new HttpProblem(503, 'Albums not available', 'Albums need migration 135_albums, which this database does not have yet. Ask an operator to run the migrations.', { extensions: { step: 'schema', migration: '135_albums' } });

export interface AuditCtx {
  ip: string | null;
  traceId?: string | null;
}

export class Albums {
  /** B-178: share and upload links. */
  readonly links: AlbumLinks;
  /** B-179: how long additions are gathered into one notification (tests set 0). */
  notifyWindowMs = 10 * 60_000;
  private schema: { ok: boolean; at: number } | null = null;

  constructor(
    private readonly s: () => Services,
    private readonly fs: FileService
  ) {
    this.links = new AlbumLinks(s, this, fs);
  }

  private get db() {
    return this.s().db;
  }

  /** Whether migration 135 is applied; a negative answer is re-checked every 30 s, so applying it needs no restart. */
  async available(): Promise<boolean> {
    const t = Date.now();
    if (this.schema && (this.schema.ok || t - this.schema.at < 30_000)) return this.schema.ok;
    let ok: boolean;
    try {
      ok = (await this.db.schema.hasTable('albums')) && (await this.db.schema.hasTable('album_items')) && (await this.db.schema.hasTable('album_contributors'));
    } catch {
      ok = false;
    }
    this.schema = { ok, at: t };
    return ok;
  }

  /** Forgets the cached schema answer (tests apply the migrations by hand). */
  resetSchemaCache(): void {
    this.schema = null;
    this.links.resetSchemaCache();
  }

  async need(): Promise<void> {
    if (!(await this.available())) throw notAvailable();
  }

  registerJobs(): void {
    this.s().jobs.register('album.notify', async (p, ctx) => this.notifyBatch(String(p.tenantId ?? ctx.job.tenant_id), String(p.albumId)));
  }

  async audit(p: Principal | null, ctx: AuditCtx, tenantId: string, action: string, target: Record<string, unknown>, label: Label, detail?: Record<string, unknown>): Promise<void> {
    await this.s().audit.append({ tenantId, action, kind: p ? 'admin' : 'system', actor: p ? actorFrom(p, ctx.ip) : { ip: ctx.ip }, target, label, ...(detail ? { detail } : {}), traceId: ctx.traceId ?? null });
  }

  // ---------- rows ----------

  async row(tenantId: string, id: string): Promise<AlbumRow | null> {
    const r = await this.db('albums').where({ tenant_id: tenantId, id }).first();
    return r ? albumFrom(r) : null;
  }

  async contributors(albumId: string): Promise<ContributorRow[]> {
    return ((await this.db('album_contributors').where({ album_id: albumId }).orderBy('added_at')) as Record<string, unknown>[]).map((r) => ({ ...(r as unknown as ContributorRow), added_at: Number(r.added_at) }));
  }

  private async items(albumId: string): Promise<AlbumItemRow[]> {
    return ((await this.db('album_items').where({ album_id: albumId }).orderBy('position').orderBy('id')) as Record<string, unknown>[]).map(itemFrom);
  }

  private async filesOf(tenantId: string, ids: string[]): Promise<Map<string, ItemFile>> {
    const out = new Map<string, ItemFile>();
    for (let i = 0; i < ids.length; i += 500) {
      for (const r of (await this.db('files').where({ tenant_id: tenantId }).whereIn('id', ids.slice(i, i + 500)).select(FILE_COLS)) as Record<string, unknown>[]) out.set(String(r.id), fileFrom(r));
    }
    return out;
  }

  // ---------- the audience and standing ----------

  /** The audience's ceiling: the workspace's, the group's label, or none for a personal album. */
  private async ceiling(a: AlbumRow): Promise<Label> {
    const s = this.s();
    if (a.kind === 'group' && a.group_id) {
      const g = await s.groups.subjects.subject(a.tenant_id, a.group_id);
      const ws = await s.tenants.workspace(a.tenant_id, a.workspace_id);
      if (!g || !ws) return 'public';
      return labelRank(g.label) < labelRank(ws.label_ceiling) ? g.label : ws.label_ceiling;
    }
    if (a.kind === 'workspace') return (await s.tenants.workspace(a.tenant_id, a.workspace_id))?.label_ceiling ?? 'public';
    return 'restricted';
  }

  /** Whether a principal is in the album's audience now (before any role). */
  private async inAudience(p: Principal, a: AlbumRow, contributor: ContributorRow | undefined): Promise<boolean> {
    if (a.kind === 'workspace') return (await workspacesFor(this.s(), p)).some((w) => w.id === a.workspace_id);
    if (a.kind === 'group') return !!a.group_id && (await this.s().groups.subjects.of(p)).has(a.group_id);
    return p.userId === a.owner_id || !!contributor;
  }

  /** The caller's standing in an album, or null when they may not know of it. */
  async accessOrNull(p: Principal, idOrRow: string | AlbumRow): Promise<Access | null> {
    const a = typeof idOrRow === 'string' ? await this.row(p.tenantId, idOrRow) : idOrRow;
    if (!a || a.tenant_id !== p.tenantId || a.deleted_at != null) return null;
    const c = (await this.db('album_contributors').where({ album_id: a.id, user_id: p.userId }).first()) as ContributorRow | undefined;
    const member = await this.inAudience(p, a, c);
    if (!member) return null;
    let standing: Standing = p.userId === a.owner_id ? 'owner' : c ? c.role : 'viewer';
    if (a.kind === 'group' && a.group_id && RANK[standing] < RANK.editor) {
      const g = await this.s().groups.accessOrNull(p, a.group_id);
      if (g && can(g, 'moderate')) standing = 'editor';
    }
    return { album: a, standing, member, cleared: clears(p.clearance, a.label), ceiling: await this.ceiling(a) };
  }

  /** Access with at least `need`; 404 outside the audience, 403 for clearance or a role too low. */
  async require(p: Principal, id: string, need: Standing = 'viewer'): Promise<Access & { standing: Standing }> {
    await this.need();
    const a = await this.accessOrNull(p, id);
    if (!a || !a.standing) throw notFound('Album');
    if (!a.cleared) throw forbidden(`This album is ${a.album.label}; your clearance is ${p.clearance}.`, { step: 'clearance' });
    if (RANK[a.standing] < RANK[need]) throw forbidden(need === 'contributor' ? 'Only contributors, editors and the owner add to this album.' : need === 'editor' ? 'Only editors and the owner change this album.' : 'Only the owner can do this.', { step: 'album-role', need, standing: a.standing });
    return a as Access & { standing: Standing };
  }

  // ---------- the access rule for items ----------

  /**
   * The items a reader may see, in order (see the header). `onlyIds` narrows to some items; the adder checks are
   * cached for the call.
   */
  async visibleItems(reader: Reader, acc: Pick<Access, 'album' | 'ceiling'>, o: { onlyIds?: Set<string> } = {}): Promise<VisibleItem[]> {
    const a = acc.album;
    let items = await this.items(a.id);
    if (o.onlyIds) items = items.filter((i) => o.onlyIds!.has(i.id));
    if (!items.length) return [];
    const files = await this.filesOf(a.tenant_id, [...new Set(items.map((i) => i.file_id))]);
    const clearance: Label = 'p' in reader ? reader.p.clearance : 'public';
    const adders = new Map<string, Promise<{ workspaces: Set<string>; clearance: Label } | null>>();
    const adder = (userId: string) => {
      let got = adders.get(userId);
      if (!got) {
        got = (async () => {
          const pr = await loadPrincipal(this.s(), a.tenant_id, userId, {});
          return pr ? { workspaces: new Set((await workspacesFor(this.s(), pr)).map((w) => w.id)), clearance: pr.clearance } : null;
        })();
        adders.set(userId, got);
      }
      return got;
    };
    const out: VisibleItem[] = [];
    for (const item of items) {
      const f = files.get(item.file_id);
      if (!f || f.state !== 'ready' || f.current_version == null || f.trashed_at != null || f.taken_down_at != null || !isAlbumMedia(f.type)) continue;
      if (!clears(clearance, f.label) || labelRank(f.label) > labelRank(acc.ceiling)) continue;
      const by = await adder(item.added_by);
      let ok = !!by && by.workspaces.has(f.workspace_id) && clears(by.clearance, f.label);
      if (!ok && 'p' in reader) ok = await this.fs.readable(reader.p, f.id).then(() => true, () => false);
      if (ok) out.push({ item, file: f });
    }
    return out;
  }

  /** One item, if the reader may see it now. */
  async visibleItem(reader: Reader, acc: Pick<Access, 'album' | 'ceiling'>, itemId: string): Promise<VisibleItem> {
    const [hit] = await this.visibleItems(reader, acc, { onlyIds: new Set([itemId]) });
    if (!hit) throw notFound('Album item');
    return hit;
  }

  /** The album's label as the high-water mark of its floor and its items (in the trash or not ready, not counted). */
  async relabel(albumId: string): Promise<AlbumRow | null> {
    const r = await this.db('albums').where({ id: albumId }).first();
    if (!r) return null;
    const a = albumFrom(r);
    const rows = (await this.db('album_items as i').join('files as f', 'f.id', 'i.file_id').where({ 'i.album_id': a.id }).whereNull('f.trashed_at').select('f.label')) as { label: string }[];
    let label: Label = a.label;
    for (const x of rows) label = highest(label, labelOf(x.label));
    const count = ((await this.db('album_items').where({ album_id: a.id }).count({ n: '*' })) as { n: number | string }[])[0];
    const n = Number(count?.n ?? 0);
    if (label !== a.effective_label || n !== a.item_count) {
      await this.db('albums').where({ id: a.id }).update({ effective_label: label, item_count: n });
      return { ...a, effective_label: label, item_count: n };
    }
    return a;
  }

  // ---------- views ----------

  private async names(tenantId: string, ids: string[]): Promise<Map<string, string>> {
    const uniq = [...new Set(ids)].filter(Boolean);
    if (!uniq.length) return new Map();
    const rows = (await this.db('users').where({ tenant_id: tenantId }).whereIn('id', uniq).select('id', 'display_name', 'username')) as { id: string; display_name: string | null; username: string }[];
    return new Map(rows.map((r) => [r.id, r.display_name || r.username]));
  }

  /** What a reader is shown of the album itself: the label is the effective one when they clear it, else what they see. */
  private summary(acc: Access, visible: VisibleItem[], p: Principal, ownerName: string | null) {
    const a = acc.album;
    let shown: Label = a.label;
    for (const v of visible) shown = highest(shown, v.file.label);
    const label = clears(p.clearance, a.effective_label) ? a.effective_label : shown;
    const cover = visible.find((v) => v.file.id === a.cover_file_id) ?? visible[0] ?? null;
    const st = acc.standing ?? 'viewer';
    return {
      id: a.id,
      kind: a.kind,
      title: a.title,
      description: a.description,
      floorLabel: a.label,
      label,
      workspaceId: a.workspace_id,
      groupId: a.group_id,
      ownerId: a.owner_id,
      ownerName,
      role: st,
      cover: cover ? { itemId: cover.item.id, fileId: cover.file.id, chosen: cover.file.id === a.cover_file_id } : null,
      itemCount: visible.length,
      can: { add: RANK[st] >= RANK.contributor, edit: RANK[st] >= RANK.editor, manage: RANK[st] >= RANK.editor, editors: st === 'owner', delete: st === 'owner', links: RANK[st] >= RANK.editor },
      createdAt: a.created_at,
      updatedAt: a.updated_at
    };
  }

  private async itemViews(a: AlbumRow, visible: VisibleItem[], p: Principal) {
    const names = await this.names(a.tenant_id, visible.map((v) => v.item.added_by));
    const meta = await this.fs.metaFor(visible.map((v) => v.file.id));
    return visible.map((v) => {
      const m = meta.get(v.file.id);
      return {
        id: v.item.id,
        fileId: v.file.id,
        name: v.file.name,
        type: v.file.type,
        kind: v.file.type && v.file.type.startsWith('video/') ? 'video' : 'image',
        size: v.file.size,
        label: v.file.label,
        position: v.item.position,
        version: v.file.current_version,
        altText: m?.alt_text ?? null,
        description: m?.description ?? null,
        addedBy: v.item.added_by,
        addedByName: names.get(v.item.added_by) ?? null,
        addedAt: v.item.added_at,
        mine: v.item.added_by === p.userId
      };
    });
  }

  /** The albums a person may open, newest first: their own, those naming them, their workspaces' and groups'. */
  async list(p: Principal, f: { kind?: AlbumKind; groupId?: string; workspaceId?: string } = {}) {
    if (!(await this.available())) return { available: false, albums: [] };
    const ws = (await workspacesFor(this.s(), p)).map((w) => w.id);
    const groups = [...(await this.s().groups.subjects.of(p))];
    const named = ((await this.db('album_contributors').where({ tenant_id: p.tenantId, user_id: p.userId }).select('album_id')) as { album_id: string }[]).map((r) => r.album_id);
    const q = this.db('albums')
      .where({ tenant_id: p.tenantId })
      .whereNull('deleted_at')
      .andWhere((b) => {
        void b.where({ owner_id: p.userId });
        if (named.length) void b.orWhereIn('id', named.slice(0, 1000));
        if (ws.length) void b.orWhere((x) => void x.where({ kind: 'workspace' }).whereIn('workspace_id', ws));
        if (groups.length) void b.orWhere((x) => void x.where({ kind: 'group' }).whereIn('group_id', groups));
      });
    if (f.kind) void q.andWhere({ kind: f.kind });
    if (f.groupId) void q.andWhere({ group_id: f.groupId });
    if (f.workspaceId) void q.andWhere({ workspace_id: f.workspaceId });
    const rows = ((await q.orderBy('updated_at', 'desc').limit(200)) as Record<string, unknown>[]).map(albumFrom);
    const owners = await this.names(p.tenantId, rows.map((r) => r.owner_id));
    const out = [];
    for (const r of rows) {
      const acc = await this.accessOrNull(p, r);
      if (!acc || !acc.cleared) continue;
      out.push(this.summary(acc, await this.visibleItems({ p }, acc), p, owners.get(r.owner_id) ?? null));
    }
    return { available: true, albums: out };
  }

  /** The album with the items the caller may see, in order, and its contributors for those who manage them. */
  async detail(p: Principal, id: string) {
    const acc = await this.require(p, id);
    const a = (await this.relabel(acc.album.id)) ?? acc.album;
    const full = { ...acc, album: a };
    const visible = await this.visibleItems({ p }, full);
    const owner = (await this.names(p.tenantId, [a.owner_id])).get(a.owner_id) ?? null;
    const manage = RANK[acc.standing] >= RANK.editor;
    const contributors = manage ? await this.contributorViews(a) : [];
    return { ...this.summary(full, visible, p, owner), items: await this.itemViews(a, visible, p), ...(manage ? { contributors } : {}) };
  }

  private async contributorViews(a: AlbumRow) {
    const rows = await this.contributors(a.id);
    const names = await this.names(a.tenant_id, rows.map((r) => r.user_id));
    return rows.map((r) => ({ userId: r.user_id, name: names.get(r.user_id) ?? null, role: r.role, addedBy: r.added_by, addedAt: r.added_at }));
  }

  /** B-179: what a feed card shows of an album (404 for a reader outside its audience or below its floor). */
  async card(p: Principal, id: string) {
    const acc = await this.require(p, id);
    const visible = await this.visibleItems({ p }, acc);
    const owner = (await this.names(p.tenantId, [acc.album.owner_id])).get(acc.album.owner_id) ?? null;
    const sum = this.summary(acc, visible, p, owner);
    const meta = await this.fs.metaFor(visible.slice(0, 4).map((v) => v.file.id));
    return { id: sum.id, kind: sum.kind, title: sum.title, description: sum.description, label: sum.label, itemCount: sum.itemCount, cover: sum.cover, ownerName: owner, preview: visible.slice(0, 4).map((v) => ({ itemId: v.item.id, name: v.file.name, type: v.file.type, altText: meta.get(v.file.id)?.alt_text ?? null })) };
  }

  /** B-179: the albums of a group, for its Albums tab. */
  async ofGroup(p: Principal, groupId: string) {
    await this.s().groups.require(p, groupId, 'read');
    const out = await this.list(p, { kind: 'group', groupId });
    const g = await this.s().groups.accessOrNull(p, groupId);
    return { ...out, canCreate: !!g && can(g, 'post') && out.available };
  }

  // ---------- create, change, delete ----------

  private checkFloor(p: Principal, label: Label, ceiling: Label, where: string): void {
    if (!clears(p.clearance, label)) throw forbidden(`Your clearance is ${p.clearance}; the album would be ${label}.`, { step: 'clearance' });
    if (labelRank(label) > labelRank(ceiling)) throw forbidden(`${where} allows up to ${ceiling}; the album would be ${label}.`, { step: 'zone' });
  }

  async create(p: Principal, ctx: AuditCtx, input: { kind: AlbumKind; title: string; description?: string | null; label?: Label; workspaceId?: string | null; groupId?: string | null }) {
    await this.need();
    const s = this.s();
    let workspaceId: string;
    let groupId: string | null = null;
    let ceiling: Label;
    let where: string;
    if (input.kind === 'group') {
      if (!input.groupId) throw new HttpProblem(422, 'No group', 'Name the group the album belongs to.');
      const g = await s.groups.require(p, input.groupId, 'post');
      if (g.group.state !== 'active') throw conflict('The group is not open for new albums.');
      groupId = g.group.id;
      workspaceId = g.group.workspace_id;
      const ws = await s.tenants.workspace(p.tenantId, workspaceId);
      ceiling = ws && labelRank(ws.label_ceiling) < labelRank(g.group.label) ? ws.label_ceiling : g.group.label;
      where = 'The group';
    } else {
      const w = await this.fs.workspaceFor(p, input.workspaceId ?? null);
      workspaceId = w.id;
      ceiling = input.kind === 'workspace' ? w.label_ceiling : 'restricted';
      where = 'The workspace';
    }
    const label = input.label ?? (labelRank(ceiling) < labelRank('internal') ? ceiling : 'internal');
    this.checkFloor(p, label, ceiling, where);
    const t = Date.now();
    const row: AlbumRow = { id: ulid(), tenant_id: p.tenantId, kind: input.kind, owner_id: p.userId, workspace_id: workspaceId, group_id: groupId, title: input.title, description: input.description ?? null, label, effective_label: label, cover_file_id: null, item_count: 0, notified_at: null, created_at: t, updated_at: t, deleted_at: null };
    await this.db('albums').insert(row);
    await this.audit(p, ctx, p.tenantId, 'album.created', { album: row.id, workspace: workspaceId, ...(groupId ? { group: groupId } : {}) }, label, { kind: row.kind, title: row.title });
    return this.detail(p, row.id);
  }

  async update(p: Principal, ctx: AuditCtx, id: string, patch: { title?: string; description?: string | null; label?: Label; coverItemId?: string | null }) {
    const acc = await this.require(p, id, 'editor');
    const a = acc.album;
    const next: Partial<AlbumRow> = {};
    if (patch.title !== undefined && patch.title !== a.title) next.title = patch.title;
    if (patch.description !== undefined && patch.description !== a.description) next.description = patch.description;
    if (patch.label !== undefined && patch.label !== a.label) {
      this.checkFloor(p, patch.label, acc.ceiling, a.kind === 'group' ? 'The group' : 'The workspace');
      // The floor never drops below what a share link promised its readers (B-178): public links need a public floor.
      next.label = patch.label;
    }
    if (patch.coverItemId !== undefined) {
      if (patch.coverItemId === null) next.cover_file_id = null;
      else next.cover_file_id = (await this.visibleItem({ p }, acc, patch.coverItemId)).file.id;
    }
    if (!Object.keys(next).length) return this.detail(p, id);
    const t = Date.now();
    await this.db('albums').where({ id: a.id }).update({ ...next, updated_at: t });
    if (next.label) await this.relabel(a.id);
    await this.audit(p, ctx, p.tenantId, 'album.updated', { album: a.id }, highest(a.effective_label, next.label ?? a.label), { changed: Object.keys(next).map((k) => (k === 'cover_file_id' ? 'cover' : k)), before: { title: a.title, label: a.label, cover: a.cover_file_id }, after: { title: next.title ?? a.title, label: next.label ?? a.label, cover: next.cover_file_id === undefined ? a.cover_file_id : next.cover_file_id } });
    return this.detail(p, id);
  }

  /** Deletes the album (its files stay where they are); its links stop working. */
  async remove(p: Principal, ctx: AuditCtx, id: string): Promise<void> {
    const acc = await this.require(p, id, 'owner');
    const t = Date.now();
    await this.db('albums').where({ id: acc.album.id }).update({ deleted_at: t, updated_at: t });
    await this.audit(p, ctx, p.tenantId, 'album.deleted', { album: acc.album.id }, acc.album.effective_label, { title: acc.album.title, items: acc.album.item_count });
  }

  // ---------- items ----------

  /**
   * Adds files the caller may share (they may change them: a member of the file's workspace cleared for its label),
   * ready and of an image or video type, whose label fits the audience's ceiling. Adding is sharing the file with the
   * album's audience, and it is refused where a share with that audience would be.
   */
  async addItems(p: Principal, ctx: AuditCtx, id: string, fileIds: string[]) {
    const acc = await this.require(p, id, 'contributor');
    const a = acc.album;
    const ids = [...new Set(fileIds)];
    if (ids.length > ALBUM_LIMITS.addPerCall) throw new HttpProblem(422, 'Too many files', `Add at most ${ALBUM_LIMITS.addPerCall} files at a time.`);
    const files = [];
    for (const fid of ids) {
      const f = await this.fs.writable(p, fid);
      if (f.state !== 'ready' || f.current_version == null) throw conflict(f.state === 'pending' ? `${f.name} is still in quarantine; add it once its scan has finished.` : `${f.name} was rejected by the scan.`);
      if (!isAlbumMedia(f.type)) throw new HttpProblem(415, 'Not a photo or video', `${f.name} is ${f.type ?? 'of an unknown type'}; albums hold PNG, JPEG, WebP and GIF images (and videos once the file store accepts them).`);
      if (labelRank(f.label) > labelRank(acc.ceiling)) throw forbidden(`${a.kind === 'group' ? 'The group' : 'The workspace'} allows up to ${acc.ceiling}; ${f.name} is ${f.label}.`, { step: 'zone' });
      files.push(f);
    }
    const existing = new Set(((await this.db('album_items').where({ album_id: a.id }).whereIn('file_id', ids)) as { file_id: string }[]).map((r) => r.file_id));
    const fresh = files.filter((f) => !existing.has(f.id));
    const count = ((await this.db('album_items').where({ album_id: a.id }).count({ n: '*' })) as { n: number | string }[])[0];
    if (Number(count?.n ?? 0) + fresh.length > ALBUM_LIMITS.items) throw new HttpProblem(422, 'Album full', `An album holds at most ${ALBUM_LIMITS.items} items.`);
    const added = await this.insertItems(a, fresh.map((f) => f.id), p.userId);
    if (added.length) {
      await this.db('albums').where({ id: a.id }).update({ updated_at: Date.now() });
      const after = await this.relabel(a.id);
      await this.audit(p, ctx, p.tenantId, 'album.item.added', { album: a.id }, after?.effective_label ?? a.effective_label, { files: added.map((x) => x.file_id), count: added.length, ...(existing.size ? { alreadyIn: [...existing] } : {}) });
      await this.scheduleNotify(a);
    }
    return { added: added.length, alreadyIn: existing.size, album: await this.detail(p, id) };
  }

  /** Inserts items at the end, in order (the position is taken again when two writers race). */
  private async insertItems(a: AlbumRow, fileIds: string[], by: string): Promise<AlbumItemRow[]> {
    if (!fileIds.length) return [];
    const max = ((await this.db('album_items').where({ album_id: a.id }).max({ n: 'position' })) as { n: number | string | null }[])[0];
    let pos = max?.n == null ? 0 : Number(max.n) + 1;
    const t = Date.now();
    const rows: AlbumItemRow[] = fileIds.map((fid, i) => ({ id: ulid(), tenant_id: a.tenant_id, album_id: a.id, file_id: fid, position: pos + i, added_by: by, added_at: t }));
    pos += rows.length;
    await this.db('album_items').insert(rows);
    return rows;
  }

  /** B-178: an upload link's file, added once its scan passed, as the link's creator (who owns the file). */
  async addUploaded(a: AlbumRow, fileId: string, by: string): Promise<{ added: boolean; reason?: string }> {
    const fresh = await this.row(a.tenant_id, a.id);
    if (!fresh || fresh.deleted_at != null) return { added: false, reason: 'The album was deleted.' };
    const f = (await this.filesOf(a.tenant_id, [fileId])).get(fileId);
    if (!f || f.state !== 'ready') return { added: false, reason: 'The file is no longer available.' };
    if (!isAlbumMedia(f.type)) return { added: false, reason: `Albums hold photos and videos; the upload is ${f.type ?? 'of an unknown type'}.` };
    const ceiling = await this.ceiling(fresh);
    if (labelRank(f.label) > labelRank(ceiling)) return { added: false, reason: `Classified ${f.label}, above what the album's audience may see (${ceiling}).` };
    if (await this.db('album_items').where({ album_id: a.id, file_id: fileId }).first('id')) return { added: true };
    await this.insertItems(fresh, [fileId], by);
    await this.db('albums').where({ id: a.id }).update({ updated_at: Date.now() });
    await this.relabel(a.id);
    await this.scheduleNotify(fresh);
    return { added: true };
  }

  /** Removes an item: contributors their own, editors and the owner any. The file stays where it is. */
  async removeItem(p: Principal, ctx: AuditCtx, id: string, itemId: string) {
    const acc = await this.require(p, id, 'contributor');
    const r = await this.db('album_items').where({ album_id: acc.album.id, id: itemId }).first();
    if (!r) throw notFound('Album item');
    const item = itemFrom(r);
    if (RANK[acc.standing] < RANK.editor && item.added_by !== p.userId) throw forbidden('Contributors remove the items they added; an editor removes the others.', { step: 'album-role' });
    // An item the caller cannot see is not theirs to remove (an editor below its label leaves it for another editor).
    if (RANK[acc.standing] >= RANK.editor && item.added_by !== p.userId) await this.visibleItem({ p }, acc, itemId);
    await this.db('album_items').where({ id: item.id }).delete();
    if (acc.album.cover_file_id === item.file_id) await this.db('albums').where({ id: acc.album.id }).update({ cover_file_id: null });
    await this.db('albums').where({ id: acc.album.id }).update({ updated_at: Date.now() });
    await this.relabel(acc.album.id);
    await this.audit(p, ctx, p.tenantId, 'album.item.removed', { album: acc.album.id, item: item.id, file: item.file_id }, acc.album.effective_label, { addedBy: item.added_by });
    return this.detail(p, id);
  }

  /**
   * Orders the items named (an editor sees only what they are cleared for): they take the places they held, in the
   * order given; the others keep theirs.
   */
  async reorder(p: Principal, ctx: AuditCtx, id: string, itemIds: string[]) {
    const acc = await this.require(p, id, 'editor');
    const wanted = [...new Set(itemIds)];
    const visible = new Map((await this.visibleItems({ p }, acc)).map((v) => [v.item.id, v.item]));
    for (const i of wanted) if (!visible.has(i)) throw notFound('Album item');
    const slots = wanted.map((i) => visible.get(i)!.position).sort((x, y) => x - y);
    await this.db.transaction(async (trx) => {
      for (let i = 0; i < wanted.length; i++) await trx('album_items').where({ id: wanted[i]! }).update({ position: slots[i]! });
    });
    await this.db('albums').where({ id: acc.album.id }).update({ updated_at: Date.now() });
    await this.audit(p, ctx, p.tenantId, 'album.reordered', { album: acc.album.id }, acc.album.effective_label, { items: wanted.length });
    return this.detail(p, id);
  }

  // ---------- contributors ----------

  /** Whether a user would be in a workspace or group album's audience (a role never reaches outside it). */
  private async userInAudience(a: AlbumRow, userId: string): Promise<boolean> {
    if (a.kind === 'personal') return true;
    const pr = await loadPrincipal(this.s(), a.tenant_id, userId, {});
    if (!pr) return false;
    return this.inAudience(pr, a, undefined);
  }

  async setContributor(p: Principal, ctx: AuditCtx, id: string, userId: string, role: AlbumRole) {
    const acc = await this.require(p, id, 'editor');
    const a = acc.album;
    if (userId === a.owner_id) throw conflict('The owner has every right in the album already.');
    const before = (await this.db('album_contributors').where({ album_id: a.id, user_id: userId }).first()) as ContributorRow | undefined;
    if (acc.standing !== 'owner' && (role === 'editor' || before?.role === 'editor')) throw forbidden('Only the owner gives or takes the editor role.', { step: 'album-role' });
    const u = await this.s().users.get(p.tenantId, userId);
    if (!u || u.state !== 'active') throw notFound('User');
    if (!(await this.userInAudience(a, userId))) throw new HttpProblem(422, 'Outside the audience', a.kind === 'group' ? `${u.display_name} is not a member of the album's group; a role in a group album is held by members only.` : `${u.display_name} is not a member of the album's workspace; a role in a workspace album is held by members only.`, { extensions: { step: 'audience' } });
    if (!before) {
      const n = ((await this.db('album_contributors').where({ album_id: a.id }).count({ n: '*' })) as { n: number | string }[])[0];
      if (Number(n?.n ?? 0) >= ALBUM_LIMITS.contributors) throw new HttpProblem(422, 'Too many people', `An album names at most ${ALBUM_LIMITS.contributors} people.`);
      await this.db('album_contributors').insert({ album_id: a.id, tenant_id: a.tenant_id, user_id: userId, role, added_by: p.userId, added_at: Date.now() });
    } else if (before.role !== role) await this.db('album_contributors').where({ album_id: a.id, user_id: userId }).update({ role });
    if (!before || before.role !== role) await this.audit(p, ctx, p.tenantId, 'album.contributor.set', { album: a.id, user: userId }, a.effective_label, { before: before?.role ?? null, after: role });
    return this.contributorViews(a);
  }

  async removeContributor(p: Principal, ctx: AuditCtx, id: string, userId: string) {
    const acc = await this.require(p, id, userId === p.userId ? 'viewer' : 'editor');
    const a = acc.album;
    const before = (await this.db('album_contributors').where({ album_id: a.id, user_id: userId }).first()) as ContributorRow | undefined;
    if (!before) throw notFound('Contributor');
    // Anyone may leave; editors remove viewers and contributors; only the owner removes an editor.
    if (userId !== p.userId && before.role === 'editor' && acc.standing !== 'owner') throw forbidden('Only the owner removes an editor.', { step: 'album-role' });
    await this.db('album_contributors').where({ album_id: a.id, user_id: userId }).delete();
    await this.audit(p, ctx, p.tenantId, 'album.contributor.removed', { album: a.id, user: userId }, a.effective_label, { role: before.role, left: userId === p.userId });
    return RANK[acc.standing] >= RANK.editor ? this.contributorViews(a) : [];
  }

  // ---------- download as a zip (streamed) ----------

  /**
   * The items a reader sees, as a ZIP streamed through `platform/zip-writer.ts`: served copies (images without their
   * metadata), stored, named after the files (made unique). Items that cannot be served are left out and counted.
   */
  zipOf(visible: VisibleItem[], o: { onDone?: (r: { files: number; skipped: number; bytes: number }) => void } = {}): AsyncGenerator<Buffer> {
    const used = new Set<string>();
    const unique = (name: string) => {
      let n = name.replace(/[\\/]/g, '_') || 'file';
      const dot = n.lastIndexOf('.');
      const [stem, ext] = dot > 0 ? [n.slice(0, dot), n.slice(dot)] : [n, ''];
      for (let i = 2; used.has(n.toLowerCase()); i++) n = `${stem} (${i})${ext}`;
      used.add(n.toLowerCase());
      return n;
    };
    let files = 0;
    let skipped = 0;
    let bytes = 0;
    const members: ZipStreamMember[] = visible.slice(0, ALBUM_LIMITS.zipItems).map((v) => ({
      name: unique(v.file.name),
      when: new Date(v.item.added_at),
      open: async () => {
        const got = await this.fs.servedCurrent(v.file.tenant_id, v.file.id);
        if (!got) throw new Error('not available');
        return got.stream;
      }
    }));
    skipped += Math.max(0, visible.length - ALBUM_LIMITS.zipItems);
    const inner = zipStream(members, { onMember: (_n, size) => { files++; bytes += size; }, onSkip: () => { skipped++; } });
    return (async function* () {
      yield* inner;
      o.onDone?.({ files, skipped, bytes });
    })();
  }

  async download(p: Principal, ctx: AuditCtx, id: string): Promise<{ name: string; stream: AsyncGenerator<Buffer> }> {
    const acc = await this.require(p, id);
    const visible = await this.visibleItems({ p }, acc);
    if (!visible.length) throw conflict('There is nothing in this album you can download.');
    const total = visible.reduce((n, v) => n + v.file.size, 0);
    if (total > 0xf000_0000) throw new HttpProblem(413, 'Too large to download at once', 'An album downloads as one zip of up to about 3.7 GiB; download its items one by one.');
    await this.audit(p, ctx, p.tenantId, 'album.downloaded', { album: acc.album.id }, visible.reduce<Label>((l, v) => highest(l, v.file.label), acc.album.label), { files: visible.slice(0, 500).map((v) => v.file.id), count: visible.length, bytes: total });
    return { name: `${acc.album.title}.zip`, stream: this.zipOf(visible) };
  }

  // ---------- B-179: the feed ----------

  /**
   * Posts the album to the feed of its workspace (a workspace album) or its group (a group album): a post whose source
   * is the album, labelled at least as high as the album, so its readers are cleared for it. The card opens the album
   * through the album's own access, so a post never shows more than the album's audience may see. A personal album
   * is not posted (its audience is the people it names).
   */
  async post(p: Principal, ctx: AuditCtx, id: string, input: { body?: string; visibility?: 'workspace' | 'unlisted' | 'public' }) {
    const acc = await this.require(p, id, 'contributor');
    const a = (await this.relabel(acc.album.id)) ?? acc.album;
    if (a.kind === 'personal') throw conflict('A personal album is seen by the people it names only; make it a workspace or group album to post it.');
    if (input.visibility === 'public' && a.effective_label !== 'public') throw forbidden(`Only an album labelled public can be posted as public; this one is ${a.effective_label}.`, { step: 'label' });
    if (!clears(p.clearance, a.effective_label)) throw forbidden(`The album is ${a.effective_label}, above your clearance of ${p.clearance}; the post would be too.`, { step: 'clearance' });
    const body = input.body?.trim() || `${a.title}`;
    const view = await this.s().feed.createPost({ p, ip: ctx.ip, traceId: ctx.traceId ?? null }, { ...(a.kind === 'group' && a.group_id ? { groupId: a.group_id } : { workspaceId: a.workspace_id }), body, label: a.effective_label, source: { kind: 'album', id: a.id }, ...(input.visibility ? { visibility: input.visibility } : {}) });
    const v = view as { id: string; state: string; label: Label };
    await this.audit(p, ctx, p.tenantId, 'album.posted', { album: a.id, post: v.id }, a.effective_label, { state: v.state, ...(a.group_id ? { group: a.group_id } : { workspace: a.workspace_id }) });
    return view;
  }

  // ---------- B-179: notifications, batched ----------

  /** Queues the album's notification for the current window (one job per album and window). */
  async scheduleNotify(a: AlbumRow): Promise<void> {
    const w = this.notifyWindowMs;
    const now = Date.now();
    const bucket = w > 0 ? Math.floor(now / w) : now;
    await this.s().jobs.enqueue({ tenantId: a.tenant_id, type: 'album.notify', payload: { tenantId: a.tenant_id, albumId: a.id }, runAt: w > 0 ? (bucket + 1) * w : now, dedupeKey: `album.notify:${a.id}:${bucket}`, maxAttempts: 2 });
  }

  /**
   * Tells the owner and the people the album names (any role) about the items added since the last notice, one
   * notification each: how many they can see, never items above their clearance, and nothing about what they added
   * themselves. Kind `album` (Sprint 49 preferences decide channel and timing).
   */
  async notifyBatch(tenantId: string, albumId: string): Promise<{ notified: number; items: number }> {
    if (!(await this.available())) return { notified: 0, items: 0 };
    const a = await this.row(tenantId, albumId);
    if (!a || a.deleted_at != null) return { notified: 0, items: 0 };
    const since = a.notified_at ?? 0;
    const fresh = ((await this.db('album_items').where({ album_id: a.id }).andWhere('added_at', '>', since).orderBy('added_at')) as Record<string, unknown>[]).map(itemFrom);
    if (!fresh.length) return { notified: 0, items: 0 };
    const through = Math.max(...fresh.map((i) => i.added_at));
    const people = [a.owner_id, ...(await this.contributors(a.id)).map((c) => c.user_id)];
    const groups = new Map<string, { userIds: string[]; n: number; label: Label }>();
    for (const userId of [...new Set(people)]) {
      const theirs = fresh.filter((i) => i.added_by !== userId);
      if (!theirs.length) continue;
      const pr = await loadPrincipal(this.s(), tenantId, userId, {});
      if (!pr) continue;
      const acc = await this.accessOrNull(pr, a);
      if (!acc || !acc.cleared) continue;
      const seen = await this.visibleItems({ p: pr }, acc, { onlyIds: new Set(theirs.map((i) => i.id)) });
      if (!seen.length) continue;
      const label = seen.reduce<Label>((l, v) => highest(l, v.file.label), a.label);
      const key = `${seen.length}:${label}`;
      const g = groups.get(key) ?? { userIds: [], n: seen.length, label };
      g.userIds.push(userId);
      groups.set(key, g);
    }
    let notified = 0;
    for (const g of groups.values()) {
      const rows = await this.s().notifications.notify({ tenantId, userIds: g.userIds, kind: 'album', title: `${g.n} ${g.n === 1 ? 'item' : 'items'} added to ${a.title}`, body: 'New photos or videos in an album you are part of.', route: `albums?album=${a.id}`, label: g.label, push: { collapseId: `album:${a.id}` } });
      notified += rows.length;
    }
    await this.db('albums').where({ id: a.id }).andWhere((q) => void q.whereNull('notified_at').orWhere('notified_at', '<', through)).update({ notified_at: through });
    return { notified, items: fresh.length };
  }
}
