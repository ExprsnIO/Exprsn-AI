import { randomBytes } from 'node:crypto';
import { ulid } from 'ulid';
import { actorFrom, isUniqueViolation } from '../audit/chain.js';
import { clears } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import { conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import type { Services } from '../services.js';
import { mac, macs } from '../vault/keyring.js';
import { GROUP_OBJECT, type Ctx, type GroupRow } from './service.js';

/*
 * 1.7.0 (B-9702, GRP-9): invite links and codes, and the message on a request or an invitation.
 *
 * A moderator makes a link for a group: a code of twenty letters and digits that admits whoever presents it as a
 * member, up to `maxUses` people and until it expires. The code is shown once, when the link is made; the server keeps
 * a keyed digest of it (the platform's `link` key) and its last four characters. A link is an invitation, so it admits
 * into a group of any join mode, but it opens nothing else: the person must be in the group's workspace, cleared for
 * its label, a member of the group for one of its channels, not banned or suspended, and the group must have room.
 * A use is counted when the person is admitted; an attempt that is refused uses nothing.
 *
 * The message a person writes with a request to join, or a moderator with an invitation, is at most 500 characters,
 * passes the `user-input` guardrail (a block or a hold refuses it, a redaction is kept redacted) and is sealed with
 * the request. The group's moderators and the person it concerns read it.
 */

export const INVITE_LIMITS = { message: 500, maxUses: 10_000, days: 365, linksPerGroup: 50 } as const;
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32: no I, L, O or U
const CODE_LENGTH = 20;

/** A new code: twenty characters in groups of five. */
export function newCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) out += ALPHABET[bytes[i]! & 31];
  return out.replace(/(.{5})(?=.)/g, '$1-');
}

/** A code as typed or pasted: upper case, without separators, with the letters people mistake for digits read as them. */
export function normaliseCode(input: string): string | null {
  const c = input.toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return c.length === CODE_LENGTH && [...c].every((ch) => ALPHABET.includes(ch)) ? c : null;
}

export interface InviteLinkRow {
  id: string;
  tenant_id: string;
  group_id: string;
  code_hash: string;
  code_hint: string;
  max_uses: number | null;
  uses: number;
  expires_at: number;
  state: 'active' | 'revoked';
  created_by: string;
  created_at: number;
  revoked_by: string | null;
  revoked_at: number | null;
}

const from = (r: Record<string, unknown>): InviteLinkRow => ({ ...(r as unknown as InviteLinkRow), max_uses: r.max_uses == null ? null : Number(r.max_uses), uses: Number(r.uses), expires_at: Number(r.expires_at), created_at: Number(r.created_at), revoked_at: r.revoked_at == null ? null : Number(r.revoked_at) });
export type LinkState = 'active' | 'revoked' | 'expired' | 'used';
export const linkState = (r: InviteLinkRow, now = Date.now()): LinkState => (r.state === 'revoked' ? 'revoked' : r.expires_at <= now ? 'expired' : r.max_uses != null && r.uses >= r.max_uses ? 'used' : 'active');
const linkView = (r: InviteLinkRow) => ({ id: r.id, groupId: r.group_id, hint: r.code_hint, maxUses: r.max_uses, uses: r.uses, remaining: r.max_uses == null ? null : Math.max(0, r.max_uses - r.uses), expiresAt: r.expires_at, state: linkState(r), createdBy: r.created_by, createdAt: r.created_at, revokedAt: r.revoked_at });
const GONE: Record<Exclude<LinkState, 'active'>, string> = { revoked: 'This invite link was withdrawn.', expired: 'This invite link expired.', used: 'This invite link has admitted as many people as it allows.' };

export class GroupInvites {
  constructor(
    private readonly s: () => Services,
    private readonly o: { inviteDays: number }
  ) {}

  private get db() {
    return this.s().db;
  }

  private digest(code: string): string {
    return mac(this.s().sysKeys.key('link'), `group-invite:${code}`);
  }

  /** Screens a request's or an invitation's message at `user-input`; returns the text to seal (null for none). */
  async screenMessage(p: Principal, g: Pick<GroupRow, 'id' | 'tenant_id' | 'workspace_id' | 'label'>, kind: 'request' | 'invite', text: string | null | undefined): Promise<string | null> {
    const t = (text ?? '').trim();
    if (!t) return null;
    const d = await this.s().guardrails.check({ tenantId: g.tenant_id, workspaceId: g.workspace_id, checkpoint: 'user-input', text: t, label: g.label, principal: p, source: { kind: GROUP_OBJECT, id: g.id }, meta: { objectType: GROUP_OBJECT, field: `${kind}-message`, group: g.id } });
    if (d.action === 'block' || d.action === 'require-approval') throw new HttpProblem(422, 'Blocked by guardrails', d.reason ?? 'The message was blocked by a guardrail rule.', { extensions: { step: 'guardrails', action: d.action, field: 'message' } });
    return d.action === 'redact' ? d.text : t;
  }

  // ---------- links (moderators) ----------

  async list(ctx: Ctx, id: string) {
    await this.s().groups.require(ctx.p, id, 'invite', { reading: true });
    return ((await this.db('group_invite_links').where({ group_id: id }).orderBy('created_at', 'desc').limit(200)) as Record<string, unknown>[]).map((r) => linkView(from(r)));
  }

  /** A new link. The code is in this answer and nowhere afterwards. */
  async create(ctx: Ctx, id: string, input: { maxUses?: number | null | undefined; expiresInDays?: number | undefined }) {
    const s = this.s();
    const a = await s.groups.require(ctx.p, id, 'invite');
    const g = a.group;
    if (g.state !== 'active') throw conflict('The group is not accepting members.');
    const now = Date.now();
    const live = ((await this.db('group_invite_links').where({ group_id: g.id, state: 'active' }).andWhere('expires_at', '>', now)) as Record<string, unknown>[]).map(from).filter((r) => linkState(r, now) === 'active');
    if (live.length >= INVITE_LIMITS.linksPerGroup) throw conflict(`A group has at most ${INVITE_LIMITS.linksPerGroup} invite links in use; withdraw one first.`);
    const code = newCode();
    const plain = normaliseCode(code)!;
    const row: InviteLinkRow = { id: ulid(), tenant_id: g.tenant_id, group_id: g.id, code_hash: this.digest(plain), code_hint: plain.slice(-4), max_uses: input.maxUses ?? null, uses: 0, expires_at: now + (input.expiresInDays ?? this.o.inviteDays) * 86_400_000, state: 'active', created_by: ctx.p.userId, created_at: now, revoked_by: null, revoked_at: null };
    await this.db('group_invite_links').insert(row);
    await s.audit.append({ tenantId: g.tenant_id, action: 'group.invite-link.created', kind: 'admin', actor: actorFrom(ctx.p, ctx.ip), target: { group: g.id, link: row.id }, label: g.label, detail: { maxUses: row.max_uses, expiresAt: row.expires_at, hint: row.code_hint }, traceId: ctx.traceId ?? null });
    return { ...linkView(row), code, url: `${s.cfg.PUBLIC_URL.replace(/\/+$/, '')}/#/groups?code=${code}` };
  }

  async revoke(ctx: Ctx, id: string, linkId: string) {
    const s = this.s();
    const a = await s.groups.require(ctx.p, id, 'invite');
    const r = await this.db('group_invite_links').where({ group_id: a.group.id, id: linkId }).first();
    if (!r) throw notFound('Invite link');
    const row = from(r);
    if (row.state === 'revoked') throw conflict('The link is already withdrawn.');
    const now = Date.now();
    await this.db('group_invite_links').where({ id: row.id, state: 'active' }).update({ state: 'revoked', revoked_by: ctx.p.userId, revoked_at: now });
    await s.audit.append({ tenantId: a.group.tenant_id, action: 'group.invite-link.revoked', kind: 'admin', actor: actorFrom(ctx.p, ctx.ip), target: { group: a.group.id, link: row.id }, label: a.group.label, detail: { uses: row.uses, maxUses: row.max_uses }, traceId: ctx.traceId ?? null });
    return linkView({ ...row, state: 'revoked', revoked_by: ctx.p.userId, revoked_at: now });
  }

  // ---------- the person with a code ----------

  /** The link and its group for a person who could be admitted to it; 404 for anyone else and for a wrong code. */
  private async resolve(p: Principal, input: string): Promise<{ link: InviteLinkRow; group: GroupRow }> {
    const s = this.s();
    const code = normaliseCode(input);
    if (!code) throw notFound('Invite link');
    const r = await this.db('group_invite_links').where({ tenant_id: p.tenantId }).whereIn('code_hash', macs(s.sysKeys.key('link'), `group-invite:${code}`)).first();
    if (!r) throw notFound('Invite link');
    const link = from(r);
    const group = await s.groups.row(p.tenantId, link.group_id);
    // Outside the group's workspace or below its label the link tells nothing, not even that it exists.
    if (!group || group.state === 'deleted' || !(await s.groups.workspaceIds(p)).includes(group.workspace_id) || !clears(p.clearance, group.label)) throw notFound('Invite link');
    return { link, group };
  }

  /** What a code leads to, before joining: the group's name and whether the link still admits. */
  async lookup(p: Principal, input: string) {
    const { link, group } = await this.resolve(p, input);
    const s = this.s();
    const parent = group.parent_id ? await s.groups.row(p.tenantId, group.parent_id) : null;
    return {
      group: { id: group.id, name: group.name, label: group.label, ...(parent ? { parentId: parent.id, parentName: parent.name } : {}) },
      state: linkState(link),
      expiresAt: link.expires_at,
      remaining: link.max_uses == null ? null : Math.max(0, link.max_uses - link.uses),
      member: !!(await s.groups.member(group.id, p.userId))
    };
  }

  /** Joins the group the code leads to. The use is counted only when the person is admitted. */
  async redeem(ctx: Ctx, input: string) {
    const s = this.s();
    const p = ctx.p;
    const { link, group: g } = await this.resolve(p, input);
    const st = linkState(link);
    if (st !== 'active') throw new HttpProblem(410, 'Gone', GONE[st], { extensions: { step: 'invite-link', state: st } });
    if (g.state !== 'active') throw conflict('The group is not accepting members.');
    await s.groups.bans.assertNone(g, p.userId, 'self');
    if (await s.groups.member(g.id, p.userId)) throw conflict('You are already a member of this group.');
    if (g.parent_id && !(await s.groups.member(g.parent_id, p.userId))) throw forbidden('Join the group first; its channels are for its members.', { step: 'parent' });
    // The place on the link is taken first, in one statement, so a limit of three never admits a fourth.
    const taken = await this.db('group_invite_links').where({ id: link.id, state: 'active' }).andWhere('expires_at', '>', Date.now()).andWhere((q) => q.whereNull('max_uses').orWhereRaw('uses < max_uses')).increment('uses', 1);
    if (!taken) throw new HttpProblem(410, 'Gone', GONE.used, { extensions: { step: 'invite-link', state: 'used' } });
    const giveBack = () => this.db('group_invite_links').where({ id: link.id }).andWhere('uses', '>', 0).decrement('uses', 1);
    const joined = await s.groups.admitByLink(ctx, g, link.id, link.created_by).catch(async (err: unknown) => {
      await giveBack();
      throw err;
    });
    if (!joined) {
      await giveBack();
      throw conflict('You are already a member of this group.');
    }
    await this.db('group_invite_uses').insert({ link_id: link.id, user_id: p.userId, used_at: Date.now() }).catch((err: unknown) => {
      if (!isUniqueViolation(err)) throw err; // someone who left and came back by the same link
    });
    return { joined: true as const, role: 'member' as const, groupId: g.id, groupName: g.name };
  }
}
