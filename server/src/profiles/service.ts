import { ulid } from 'ulid';
import { actorFrom } from '../audit/chain.js';
import { clears, type Label } from '../authz/labels.js';
import { effectivePermissions, type Principal } from '../authz/policy.js';
import { json } from '../db/knex.js';
import { IMAGE_TYPES } from '../files/scan.js';
import { workspacesFor } from '../http/middleware.js';
import { forbidden, HttpProblem, notFound } from '../http/problem.js';
import type { Services } from '../services.js';

/*
 * Profiles (B-5801): what a person says about themselves beyond the name their user store gives them.
 *
 * - Pronouns and a bio pass the `user-input` guardrail like a post or a message: a block or a hold refuses the change
 *   (422, step guardrails), a redaction is what gets stored.
 * - The avatar is an image in the file store, uploaded into the person's current workspace and so through the file
 *   store's quarantine (type check from the bytes, text classifier, ClamAV when configured). The profile pins that
 *   version; it is served only once the version is `ready` and is an image. A version that fails the scan, a file in
 *   the trash (deleted or taken down by moderation), or a label above the viewer's clearance is never served.
 * - Visibility: a profile is known to people who share a workspace with its owner (anyone else gets 404, as for the
 *   person picker). Of those, a viewer sees the pronouns, bio and avatar only when their clearance reaches the
 *   profile's label and, when the owner named workspaces, they share one of those. Someone in a block with the owner
 *   (either way) sees the name only, the same view as a narrowed profile, so a block is not revealed by it.
 */

export const PROFILE_LIMITS = { pronouns: 40, bio: 500, avatarBytes: 2 * 1024 * 1024 } as const;
export const AVATAR_TYPES = IMAGE_TYPES;

export interface ProfileRow {
  tenant_id: string;
  user_id: string;
  pronouns: string | null;
  bio: string | null;
  label: Label;
  workspaces: string[] | null;
  avatar_file_id: string | null;
  avatar_version: number | null;
  created_at: number;
  updated_at: number;
}

export interface Ctx {
  p: Principal;
  ip: string | null;
  traceId?: string | null;
}

export type AvatarState = 'quarantined' | 'scanning' | 'ready' | 'rejected' | 'gone' | 'not an image';

const PROFILE_OBJECT = 'profile';
const rowFrom = (r: Record<string, unknown>): ProfileRow => ({ ...(r as unknown as ProfileRow), workspaces: json<string[] | null>(r.workspaces, null), avatar_version: r.avatar_version == null ? null : Number(r.avatar_version), created_at: Number(r.created_at), updated_at: Number(r.updated_at) });
const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

export class ProfileService {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  private async audit(ctx: Ctx, action: string, detail: Record<string, unknown>, label: Label = 'internal'): Promise<void> {
    await this.s().audit.append({ tenantId: ctx.p.tenantId, action, kind: 'admin', actor: actorFrom(ctx.p, ctx.ip), target: { user: ctx.p.userId }, detail, label, traceId: ctx.traceId ?? null });
  }

  async row(tenantId: string, userId: string): Promise<ProfileRow | null> {
    const r = await this.db('user_profiles').where({ tenant_id: tenantId, user_id: userId }).first();
    return r ? rowFrom(r) : null;
  }

  private blank(tenantId: string, userId: string): ProfileRow {
    const t = Date.now();
    return { tenant_id: tenantId, user_id: userId, pronouns: null, bio: null, label: 'internal', workspaces: null, avatar_file_id: null, avatar_version: null, created_at: t, updated_at: t };
  }

  private async save(row: ProfileRow): Promise<void> {
    const values = { pronouns: row.pronouns, bio: row.bio, label: row.label, workspaces: row.workspaces ? JSON.stringify(row.workspaces) : null, avatar_file_id: row.avatar_file_id, avatar_version: row.avatar_version, updated_at: row.updated_at };
    const n = await this.db('user_profiles').where({ tenant_id: row.tenant_id, user_id: row.user_id }).update(values);
    if (!n) {
      try {
        await this.db('user_profiles').insert({ tenant_id: row.tenant_id, user_id: row.user_id, created_at: row.created_at, ...values });
      } catch {
        // Two first saves at once: the other one inserted the row.
        await this.db('user_profiles').where({ tenant_id: row.tenant_id, user_id: row.user_id }).update(values);
      }
    }
  }

  private async user(tenantId: string, id: string): Promise<{ id: string; username: string; display_name: string } | null> {
    const u = (await this.db('users').where({ tenant_id: tenantId, id, state: 'active' }).first('id', 'username', 'display_name')) as { id: string; username: string; display_name: string } | undefined;
    return u ?? null;
  }

  /** The avatar's state: null without one. */
  async avatarState(row: ProfileRow | null): Promise<{ state: AvatarState; label: Label | null; type: string | null } | null> {
    if (!row?.avatar_file_id || row.avatar_version == null) return null;
    const v = await this.s().files.pinnedVersion(row.tenant_id, row.avatar_file_id, row.avatar_version);
    if (v.state === 'ready' && !(v.type && AVATAR_TYPES.includes(v.type))) return { state: 'not an image', label: v.label, type: v.type };
    return { state: v.state, label: v.label, type: v.type };
  }

  private avatarUrl(row: ProfileRow): string {
    return `/api/people/${row.user_id}/avatar?v=${row.avatar_version}`;
  }

  /** The caller's own profile, everything included (what Settings edits). */
  async own(p: Principal) {
    const row = (await this.row(p.tenantId, p.userId)) ?? this.blank(p.tenantId, p.userId);
    const avatar = await this.avatarState(row);
    const presence = await this.s().presence.mine(p);
    return {
      userId: p.userId,
      username: p.username,
      displayName: p.displayName,
      pronouns: row.pronouns,
      bio: row.bio,
      label: row.label,
      workspaces: row.workspaces,
      avatar: avatar ? { fileId: row.avatar_file_id, version: row.avatar_version, state: avatar.state, url: avatar.state === 'ready' ? this.avatarUrl(row) : null } : null,
      presence,
      updatedAt: row.updated_at
    };
  }

  /** Screens a profile field at `user-input`; returns the text to store. */
  private async screen(p: Principal, field: 'pronouns' | 'bio', text: string, label: Label): Promise<string> {
    const d = await this.s().guardrails.check({ tenantId: p.tenantId, workspaceId: p.workspaceId ?? null, checkpoint: 'user-input', text, label, principal: p, source: { kind: PROFILE_OBJECT, id: p.userId }, meta: { objectType: PROFILE_OBJECT, field } });
    if (d.action === 'block' || d.action === 'require-approval') throw new HttpProblem(422, 'Blocked by guardrails', d.reason ?? `Your ${field} was blocked by a guardrail rule.`, { extensions: { step: 'guardrails', action: d.action, field } });
    return d.action === 'redact' ? d.text : text;
  }

  async update(ctx: Ctx, patch: { pronouns?: string | null; bio?: string | null; label?: Label; workspaces?: string[] | null }) {
    const p = ctx.p;
    const before = (await this.row(p.tenantId, p.userId)) ?? this.blank(p.tenantId, p.userId);
    const next: ProfileRow = { ...before, updated_at: Date.now() };
    if (patch.label !== undefined) {
      if (!clears(p.clearance, patch.label)) throw forbidden(`Your clearance is ${p.clearance}; the profile would be ${patch.label}.`, { step: 'clearance' });
      next.label = patch.label;
    }
    if (patch.workspaces !== undefined) {
      if (patch.workspaces === null || !patch.workspaces.length) next.workspaces = null;
      else {
        const mine = new Set((await workspacesFor(this.s(), p)).map((w) => w.id));
        const unknown = patch.workspaces.filter((w) => !mine.has(w));
        if (unknown.length) throw new HttpProblem(422, 'Not your workspace', 'A profile can be shown only in workspaces you are a member of.', { extensions: { step: 'workspace', workspaces: unknown } });
        next.workspaces = [...new Set(patch.workspaces)];
      }
    }
    const changed: string[] = [];
    let redacted = false;
    for (const field of ['pronouns', 'bio'] as const) {
      const v = patch[field];
      if (v === undefined) continue;
      const text = v == null ? null : v.trim() || null;
      const stored = text == null ? null : await this.screen(p, field, text, next.label);
      if (stored !== text) redacted = true;
      next[field] = stored;
    }
    for (const k of ['pronouns', 'bio', 'label'] as const) if (next[k] !== before[k]) changed.push(k);
    if (JSON.stringify(next.workspaces) !== JSON.stringify(before.workspaces)) changed.push('workspaces');
    await this.save(next);
    // The text itself is not audited; which fields changed, the label and the workspaces are.
    if (changed.length) await this.audit(ctx, 'profile.updated', { fields: changed, label: next.label, workspaces: next.workspaces, ...(redacted ? { redacted: true } : {}) }, next.label);
    return this.own(p);
  }

  /** A new avatar: the image goes into the file store in the caller's current workspace and through its quarantine. */
  async setAvatar(ctx: Ctx, input: { declaredType: string | null; declaredBytes: number | null }, body: AsyncIterable<Buffer | Uint8Array>) {
    const p = ctx.p;
    if (!effectivePermissions(p).has('files:write')) throw forbidden('An avatar is stored in the file store, which needs files:write.', { step: 'role' });
    const type = (input.declaredType ?? '').split(';')[0]!.trim().toLowerCase();
    if (!AVATAR_TYPES.includes(type)) throw new HttpProblem(415, 'Not an image', `An avatar is a PNG, JPEG, WebP or GIF image; this upload is ${type || 'untyped'}.`);
    if (input.declaredBytes != null && input.declaredBytes > PROFILE_LIMITS.avatarBytes) throw new HttpProblem(413, 'Payload too large', `An avatar is at most ${PROFILE_LIMITS.avatarBytes.toLocaleString('en-US')} bytes.`, { extensions: { max: PROFILE_LIMITS.avatarBytes } });
    const row = (await this.row(p.tenantId, p.userId)) ?? this.blank(p.tenantId, p.userId);
    const wsId = p.workspaceId ?? (await workspacesFor(this.s(), p))[0]?.id ?? null;
    const ws = wsId ? await this.s().files.workspaceFor(p, wsId).catch(() => null) : null;
    if (!ws) throw new HttpProblem(409, 'No workspace', 'An avatar is kept in the file store of your current workspace, and you have none.', { extensions: { step: 'workspace' } });
    const max = PROFILE_LIMITS.avatarBytes;
    let bytes = 0;
    const capped = async function* () {
      for await (const c of body) {
        bytes += c.byteLength;
        if (bytes > max) throw new HttpProblem(413, 'Payload too large', `An avatar is at most ${max.toLocaleString('en-US')} bytes.`, { extensions: { max } });
        yield c;
      }
    };
    const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ').replace(/:/g, '.');
    const name = `Profile picture ${stamp} ${ulid().slice(-6)}.${EXT[type]}`;
    const { file, version } = await this.s().files.upload(p, { workspaceId: ws.id, folderId: null, name, label: row.label, declaredType: type, declaredBytes: input.declaredBytes }, capped());
    await this.s().audit.append({ tenantId: p.tenantId, action: 'file.upload.received', kind: 'admin', actor: actorFrom(p, ctx.ip), target: { file: file.id, version: version.number, workspace: file.workspace_id }, label: version.label, detail: { name: file.name, size: version.size, sha256: version.sha256, folder: null, via: 'profile' }, traceId: ctx.traceId ?? null });
    const before = row.avatar_file_id;
    await this.save({ ...row, avatar_file_id: file.id, avatar_version: version.number, updated_at: Date.now() });
    await this.audit(ctx, 'profile.avatar.set', { file: file.id, version: version.number, workspace: ws.id, ...(before ? { replaced: before } : {}) }, row.label);
    return this.own(p);
  }

  async removeAvatar(ctx: Ctx) {
    const p = ctx.p;
    const row = await this.row(p.tenantId, p.userId);
    if (row?.avatar_file_id) {
      await this.save({ ...row, avatar_file_id: null, avatar_version: null, updated_at: Date.now() });
      // The image stays in the file store, where its owner can trash it.
      await this.audit(ctx, 'profile.avatar.removed', { file: row.avatar_file_id, version: row.avatar_version }, row.label);
    }
    return this.own(p);
  }

  /** What a viewer may know of someone: 404 when they share no workspace, else the visible parts. */
  async view(p: Principal, targetId: string) {
    const s = this.s();
    if (targetId === p.userId) return { ...(await this.own(p)), self: true, limited: null, sharedWorkspaces: (await workspacesFor(s, p)).map((w) => ({ id: w.id, name: w.name })), relation: null };
    const u = await this.user(p.tenantId, targetId);
    if (!u) throw notFound('User');
    const shared = await s.social.sharedWorkspaces(p, targetId);
    if (!shared.length) throw notFound('User');
    const names = new Map((await workspacesFor(s, p)).map((w) => [w.id, w.name]));
    const blocked = await s.social.isBlocked(p.tenantId, p.userId, targetId);
    const row = await this.row(p.tenantId, targetId);
    const label = row?.label ?? 'internal';
    const inWorkspaces = !row?.workspaces || row.workspaces.some((w) => shared.includes(w));
    const limited: 'clearance' | 'hidden' | null = blocked || !inWorkspaces ? 'hidden' : !clears(p.clearance, label) ? 'clearance' : null;
    const avatar = !limited ? await this.avatarState(row) : null;
    const showAvatar = !!avatar && avatar.state === 'ready' && !!avatar.label && clears(p.clearance, avatar.label);
    const presence = blocked ? null : (await s.presence.statuses(p, [targetId]))[targetId] ?? null;
    return {
      userId: u.id,
      username: u.username,
      displayName: u.display_name,
      self: false,
      limited,
      ...(limited ? {} : { pronouns: row?.pronouns ?? null, bio: row?.bio ?? null, label }),
      avatar: showAvatar ? { url: this.avatarUrl(row!) } : null,
      presence: presence ? { status: presence } : null,
      sharedWorkspaces: shared.map((id) => ({ id, name: names.get(id) ?? 'a workspace' })),
      relation: await s.social.relation(p, targetId).catch(() => null)
    };
  }

  /** The avatar image for a viewer the profile is visible to; 404 for anything that is not a ready image they clear. */
  async avatar(p: Principal, targetId: string): Promise<{ type: string; size: number; stream: AsyncIterable<Buffer> }> {
    const v = await this.view(p, targetId);
    if (!v.avatar) throw notFound('Avatar');
    const row = (await this.row(p.tenantId, targetId))!;
    const got = await this.s().files.pinnedContent(p.tenantId, row.avatar_file_id!, row.avatar_version!);
    if (!got || !got.type || !AVATAR_TYPES.includes(got.type) || !clears(p.clearance, got.label)) throw notFound('Avatar');
    return { type: got.type, size: got.size, stream: got.stream };
  }
}
