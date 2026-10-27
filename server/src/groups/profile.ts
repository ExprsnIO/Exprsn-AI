import { ulid } from 'ulid';
import type { Knex } from 'knex';
import { actorFrom } from '../audit/chain.js';
import { clears, type Label } from '../authz/labels.js';
import { effectivePermissions, type Principal } from '../authz/policy.js';
import { forbidden, HttpProblem, notFound } from '../http/problem.js';
import type { Services } from '../services.js';
import { GROUP_OBJECT, type Ctx, type GroupRow } from './service.js';

/*
 * 1.7.0 (B-9703): a group's profile fields and its member limit.
 *
 * - Tags: up to ten short lower-case labels, kept in the clear like the name (the list searches them).
 * - Website: one http(s) address without credentials.
 * - Avatar and banner: images in the file store, uploaded into the group's workspace at the group's label and so
 *   through the file store's quarantine and scan. The group pins the version; the image is served only once that
 *   version is released, and only to a viewer who clears the file's label, as a person's avatar is (B-3501).
 * - Member limit: at the limit the group takes no join, no request to join and no invitation, and a pending request or
 *   invitation is not accepted. Lowering the limit below the present count removes nobody.
 *
 * Tags and the website are what a member wrote: they pass the `user-input` guardrail, which may refuse or redact them.
 * All of it is shown to whoever may know the group exists, like its name.
 */

export const GROUP_PROFILE_LIMITS = { tags: 10, tagLength: 30, website: 300, avatarBytes: 2 * 1024 * 1024, bannerBytes: 5 * 1024 * 1024, memberLimit: 100_000 } as const;
export const IMAGE_KINDS = ['avatar', 'banner'] as const;
export type ImageKind = (typeof IMAGE_KINDS)[number];
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

/** Tags as stored: trimmed, lower case, inner spaces collapsed, no duplicates, in the order given. */
export function normaliseTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of tags) {
    const t = raw.trim().toLowerCase().replace(/\s+/g, ' ').replace(/^#+/, '');
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

export function tagsOf(v: unknown): string[] {
  if (typeof v !== 'string' || !v) return [];
  try {
    const a: unknown = JSON.parse(v);
    return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** A website as stored: an absolute http(s) URL without a user name or password. */
export function websiteOf(input: string): string {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw new HttpProblem(422, 'Not a web address', 'Give the full address, starting with https://.', { extensions: { step: 'website' } });
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new HttpProblem(422, 'Not a web address', 'A website starts with https:// or http://.', { extensions: { step: 'website' } });
  if (u.username || u.password) throw new HttpProblem(422, 'Not a web address', 'A website address carries no user name or password.', { extensions: { step: 'website' } });
  if (u.href.length > GROUP_PROFILE_LIMITS.website) throw new HttpProblem(422, 'Not a web address', `A website address is at most ${GROUP_PROFILE_LIMITS.website} characters.`, { extensions: { step: 'website' } });
  return u.href;
}

type ImageState = 'scanning' | 'ready' | 'rejected' | 'gone' | 'not an image';
const cols = (kind: ImageKind) => ({ file: `${kind}_file_id` as const, version: `${kind}_version` as const });

export class GroupProfile {
  constructor(private readonly s: () => Services) {}

  /** Screens tags or a website at `user-input`; returns the text to store. */
  async screen(p: Principal, g: Pick<GroupRow, 'id' | 'tenant_id' | 'workspace_id' | 'label'>, field: 'tags' | 'website', text: string): Promise<string> {
    const d = await this.s().guardrails.check({ tenantId: g.tenant_id, workspaceId: g.workspace_id, checkpoint: 'user-input', text, label: g.label, principal: p, source: { kind: GROUP_OBJECT, id: g.id }, meta: { objectType: GROUP_OBJECT, field, group: g.id } });
    if (d.action === 'block' || d.action === 'require-approval') throw new HttpProblem(422, 'Blocked by guardrails', d.reason ?? `The group’s ${field} were blocked by a guardrail rule.`, { extensions: { step: 'guardrails', action: d.action, field } });
    return d.action === 'redact' ? d.text : text;
  }

  /** The columns of a tags or website change, screened. A redacted tag list is split again on its separator. */
  async columns(p: Principal, g: Pick<GroupRow, 'id' | 'tenant_id' | 'workspace_id' | 'label'>, patch: { tags?: string[] | undefined; website?: string | null | undefined; memberLimit?: number | null | undefined }): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    if (patch.tags !== undefined) {
      let tags = normaliseTags(patch.tags);
      if (tags.length) tags = normaliseTags((await this.screen(p, g, 'tags', tags.join('\n'))).split('\n')).map((t) => t.slice(0, GROUP_PROFILE_LIMITS.tagLength));
      out.tags = tags.length ? JSON.stringify(tags.slice(0, GROUP_PROFILE_LIMITS.tags)) : null;
    }
    if (patch.website !== undefined) {
      const site = patch.website ? websiteOf(patch.website) : null;
      // A redaction that leaves no address leaves no website.
      out.website = site ? websiteOrNull(await this.screen(p, g, 'website', site)) : null;
    }
    if (patch.memberLimit !== undefined) out.member_limit = patch.memberLimit;
    return out;
  }

  private async state(g: GroupRow, kind: ImageKind): Promise<{ state: ImageState; label: Label | null; type: string | null } | null> {
    const c = cols(kind);
    if (!g[c.file] || g[c.version] == null) return null;
    const v = await this.s().files.pinnedVersion(g.tenant_id, g[c.file]!, g[c.version]!);
    if (v.state === 'ready' && !(v.type && IMAGE_TYPES.includes(v.type))) return { state: 'not an image', label: v.label, type: v.type };
    return { state: v.state === 'quarantined' ? 'scanning' : v.state, label: v.label, type: v.type };
  }

  /** What a viewer sees of the group's profile: the fields, and each image once it is released and they clear it. */
  async view(g: GroupRow, viewer: Pick<Principal, 'clearance'> | null, members?: number) {
    const image = async (kind: ImageKind) => {
      const st = await this.state(g, kind);
      if (!st) return null;
      const shown = st.state === 'ready' && !!st.label && (!viewer || clears(viewer.clearance, st.label));
      return { state: st.state, url: shown ? `/api/groups/${g.id}/${kind}?v=${g[cols(kind).version]}` : null };
    };
    return {
      tags: tagsOf(g.tags),
      website: g.website,
      memberLimit: g.member_limit,
      ...(members !== undefined ? { full: g.member_limit != null && members >= g.member_limit } : {}),
      avatar: await image('avatar'),
      banner: await image('banner')
    };
  }

  /** A new avatar or banner: the image goes into the file store of the group's workspace and through its quarantine. */
  async setImage(ctx: Ctx, id: string, kind: ImageKind, input: { declaredType: string | null; declaredBytes: number | null }, body: AsyncIterable<Buffer | Uint8Array>) {
    const s = this.s();
    const p = ctx.p;
    const a = await s.groups.require(p, id, 'settings');
    const g = a.group;
    if (!effectivePermissions(p).has('files:write')) throw forbidden(`A group’s ${kind} is stored in the file store, which needs files:write.`, { step: 'role' });
    const type = (input.declaredType ?? '').split(';')[0]!.trim().toLowerCase();
    if (!IMAGE_TYPES.includes(type)) throw new HttpProblem(415, 'Not an image', `A group’s ${kind} is a PNG, JPEG, WebP or GIF image; this upload is ${type || 'untyped'}.`);
    const max = kind === 'avatar' ? GROUP_PROFILE_LIMITS.avatarBytes : GROUP_PROFILE_LIMITS.bannerBytes;
    const tooLarge = () => new HttpProblem(413, 'Payload too large', `A group’s ${kind} is at most ${max.toLocaleString('en-US')} bytes.`, { extensions: { max } });
    if (input.declaredBytes != null && input.declaredBytes > max) throw tooLarge();
    const ws = await s.files.workspaceFor(p, g.workspace_id).catch(() => null);
    if (!ws) throw new HttpProblem(409, 'No workspace', 'The image is kept in the file store of the group’s workspace, which you cannot write to.', { extensions: { step: 'workspace' } });
    let bytes = 0;
    const capped = async function* () {
      for await (const c of body) {
        bytes += c.byteLength;
        if (bytes > max) throw tooLarge();
        yield c;
      }
    };
    const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ').replace(/:/g, '.');
    const name = `Group ${kind} ${stamp} ${ulid().slice(-6)}.${EXT[type]}`;
    const { file, version } = await s.files.upload(p, { workspaceId: ws.id, folderId: null, name, label: g.label, declaredType: type, declaredBytes: input.declaredBytes }, capped());
    await s.audit.append({ tenantId: p.tenantId, action: 'file.upload.received', kind: 'admin', actor: actorFrom(p, ctx.ip), target: { file: file.id, version: version.number, workspace: file.workspace_id }, label: version.label, detail: { name: file.name, size: version.size, sha256: version.sha256, folder: null, via: 'group' }, traceId: ctx.traceId ?? null });
    const c = cols(kind);
    const before = g[c.file];
    await s.db('social_groups').where({ id: g.id }).update({ [c.file]: file.id, [c.version]: version.number, updated_at: Date.now() });
    await s.audit.append({ tenantId: p.tenantId, action: `group.${kind}.set`, kind: 'admin', actor: actorFrom(p, ctx.ip), target: { group: g.id, file: file.id, version: version.number, workspace: g.workspace_id }, label: g.label, detail: before ? { replaced: before } : {}, traceId: ctx.traceId ?? null });
    return s.groups.view(p, g.id);
  }

  async removeImage(ctx: Ctx, id: string, kind: ImageKind) {
    const s = this.s();
    const a = await s.groups.require(ctx.p, id, 'settings');
    const g = a.group;
    const c = cols(kind);
    if (g[c.file]) {
      await s.db('social_groups').where({ id: g.id }).update({ [c.file]: null, [c.version]: null, updated_at: Date.now() });
      // The image stays in the file store, where its owner can trash it.
      await s.audit.append({ tenantId: ctx.p.tenantId, action: `group.${kind}.removed`, kind: 'admin', actor: actorFrom(ctx.p, ctx.ip), target: { group: g.id, file: g[c.file], version: g[c.version] }, label: g.label, traceId: ctx.traceId ?? null });
    }
    return s.groups.view(ctx.p, g.id);
  }

  /** The image for a viewer who may know the group; 404 for anything that is not a released image they clear. */
  async image(p: Principal, id: string, kind: ImageKind): Promise<{ type: string; size: number; stream: AsyncIterable<Buffer> }> {
    const s = this.s();
    const a = await s.groups.access(p, id);
    const c = cols(kind);
    const g = a.group;
    if (!g[c.file] || g[c.version] == null) throw notFound('Image');
    const got = await s.files.pinnedContent(p.tenantId, g[c.file]!, g[c.version]!);
    if (!got || !got.type || !IMAGE_TYPES.includes(got.type) || !clears(p.clearance, got.label)) throw notFound('Image');
    return { type: got.type, size: got.size, stream: got.stream };
  }

  /**
   * Refuses when the group is at its member limit. Inside a transaction the group's row is read with a lock first
   * (PostgreSQL and MySQL; SQLite has one writer), so two joins cannot both take the last place.
   */
  async assertRoom(g: Pick<GroupRow, 'id' | 'name'>, trx?: Knex.Transaction): Promise<void> {
    const db = trx ?? this.s().db;
    const q = db('social_groups').where({ id: g.id }).select('member_limit');
    const sqlite = /sqlite/.test(String(db.client.config.client));
    const row = (await (trx && !sqlite ? q.forUpdate() : q).first()) as { member_limit: number | string | null } | undefined;
    const limit = row?.member_limit == null ? null : Number(row.member_limit);
    if (limit == null) return;
    const n = (await db('group_members').where({ group_id: g.id }).count({ n: '*' })) as { n: number | string }[];
    if (Number(n[0]?.n ?? 0) >= limit) throw new HttpProblem(409, 'Group full', `${g.name} has reached its limit of ${limit.toLocaleString('en-US')} member${limit === 1 ? '' : 's'}.`, { extensions: { step: 'member-limit', limit } });
  }
}

function websiteOrNull(text: string): string | null {
  try {
    return websiteOf(text);
  } catch {
    return null;
  }
}
