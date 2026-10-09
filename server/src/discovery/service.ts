import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { clears, highest, labelRank, type Label } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import { json } from '../db/knex.js';
import { HttpProblem } from '../http/problem.js';
import { cosine, decodeVector, encodeVector } from '../platform/vectors.js';
import type { EntryRow, SideEffect } from '../registry/service.js';
import type { Services } from '../services.js';

/*
 * 1.7.0, Sprint 41d (B-12301 to B-12304): finding what you can use.
 *
 * The catalogue is the workspace form of the conversation's capabilities (`ChatInvocations.workspaceCapabilities`):
 * the same decision, through the same dispatcher, agents, skills and workflows, with no conversation. On top of it the
 * catalogue lists what a profile's allow-list hides (a tool on another profile the person may pick, a skill outside
 * the profile's skill list) as "not on this profile" with the profiles that offer it, and drops every entry whose
 * label is above the person's clearance, whether it is callable or not. Nothing here grants anything: calls still go
 * through the conversation routes and their checks.
 *
 * Publish notices (B-12302) go out once per person and entry (the unique key of `catalog_notices`), only to members
 * of the workspaces the entry is published to whose clearance reaches its label, through the notifications service,
 * as each one happens or in a weekly digest, or not at all, as the person chose.
 *
 * Suggestions (B-12303) rank the entries a conversation (or the workspace, before one exists) may call by the cosine
 * similarity between the draft and each entry's name, description, purpose and examples, embedded by the embedding
 * profile `DISCOVERY_EMBED_PROFILE`; no chat model is called. Entry vectors are cached per entry version and model.
 */

export const CATALOG_KINDS = ['workflow', 'agent', 'tool', 'skill'] as const;
export type CatalogKind = (typeof CATALOG_KINDS)[number];
export const NOTICE_MODES = ['each', 'digest', 'off'] as const;
export type NoticeMode = (typeof NOTICE_MODES)[number];

/** Where an entry without a category is listed. */
export const OTHER_CATEGORY = 'Other';
/** How often a digest goes out. */
export const DIGEST_MS = 7 * 24 * 60 * 60_000;
/** The most suggestions offered for one draft. */
export const MAX_SUGGESTIONS = 3;

const TRIGGER: Record<CatalogKind, '/' | '@' | '+'> = { workflow: '/', tool: '/', agent: '@', skill: '+' };
const KIND_WORD: Record<CatalogKind, string> = { workflow: 'Workflow', tool: 'Tool', agent: 'Agent', skill: 'Skill' };

export interface Discovery {
  purpose: string | null;
  examples: string[];
  category: string | null;
}

export interface CatalogEntry {
  key: string;
  kind: CatalogKind;
  id: string | null;
  name: string;
  version: string;
  description: string | null;
  purpose: string | null;
  examples: string[];
  example: string | null;
  category: string;
  label: Label;
  sideEffect: SideEffect | null;
  /** How to call it from the composer: `/name`, `@name` or `+name`. */
  call: string;
  trigger: '/' | '@' | '+';
  /** What the composer is filled with. */
  compose: string;
  available: boolean;
  /** Why it cannot be called through the chosen profile (`not on this profile`), else null. */
  reason: string | null;
  /** The profiles the person may pick that offer it, when it is not on this one. */
  profiles: string[];
  /** The catalogue fields the entry's author has not filled. */
  missing: ('purpose' | 'examples' | 'category')[];
}

export const keyOf = (kind: CatalogKind, name: string): string => `${kind}:${name}`;

/** The catalogue fields missing from an entry. */
export function missingOf(d: Partial<Discovery>): ('purpose' | 'examples' | 'category')[] {
  const out: ('purpose' | 'examples' | 'category')[] = [];
  if (!d.purpose?.trim()) out.push('purpose');
  if (!(d.examples ?? []).some((x) => x.trim())) out.push('examples');
  if (!d.category?.trim()) out.push('category');
  return out;
}

/** What the composer is filled with for an entry: its call and the first example prompt. */
export function composeFor(kind: CatalogKind, name: string, example: string | null): string {
  if (kind === 'agent') return `@${name}: ${example ?? ''}`.trimEnd() + (example ? '' : ' ');
  if (kind === 'skill') return `+${name}${example ? ` ${example}` : ' '}`;
  return `/${name}${example ? ` ${example}` : ' '}`;
}

/** A catalogue card from an entry's own fields (the registry review's preview, B-12304). */
export function cardOf(kind: CatalogKind, e: { id?: string | null; name: string; version: string; description: string | null; label: Label; sideEffect?: SideEffect | null } & Partial<Discovery>, extra: Partial<CatalogEntry> = {}): CatalogEntry {
  const examples = (e.examples ?? []).filter((x) => x.trim());
  const example = examples[0] ?? null;
  return {
    key: keyOf(kind, e.name),
    kind,
    id: e.id ?? null,
    name: e.name,
    version: e.version,
    description: e.description,
    purpose: e.purpose ?? null,
    examples,
    example,
    category: e.category?.trim() || OTHER_CATEGORY,
    label: e.label,
    sideEffect: e.sideEffect ?? null,
    call: `${TRIGGER[kind]}${e.name}`,
    trigger: TRIGGER[kind],
    compose: composeFor(kind, e.name, example),
    available: true,
    reason: null,
    profiles: [],
    missing: missingOf(e),
    ...extra
  };
}

const textOf = (e: CatalogEntry): string => [e.name.replace(/[-_.:]+/g, ' '), e.description ?? '', e.purpose ?? '', ...e.examples].filter(Boolean).join('. ');
const hash = (t: string): string => createHash('sha256').update(t).digest('hex');

export class DiscoveryService {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  // ---------- B-12301: the catalogue ----------

  /** The catalogue fields of the registry entries and workflows the capabilities name. */
  private async discoveryOf(tenantId: string): Promise<{ entries: Map<string, EntryRow>; workflows: Map<string, Discovery & { id: string; version: string }> }> {
    const s = this.s();
    const entries = new Map<string, EntryRow>();
    for (const e of await s.registry.list(tenantId)) if (e.status === 'published' || e.status === 'deprecated') entries.set(`${e.kind}:${e.name}@${e.version}`, e);
    const rows = (await this.db('workflows').where({ tenant_id: tenantId }).select('id', 'purpose', 'examples', 'category', 'published_version')) as { id: string; purpose: string | null; examples: unknown; category: string | null; published_version: number | null }[];
    // A workflow's catalogue version is its published version (its vector is cached per version).
    const workflows = new Map(rows.map((r) => [r.id, { id: r.id, version: `v${Number(r.published_version ?? 0)}`, purpose: r.purpose ?? null, examples: json<string[] | null>(r.examples, null) ?? [], category: r.category ?? null }]));
    return { entries, workflows };
  }

  /**
   * The catalogue for the caller's current workspace through a profile (the one named, else the first they may pick):
   * the entries they may call, then the ones the profile's allow-list hides with the profiles that offer them. Never
   * an entry whose label is above the caller's clearance.
   */
  async catalog(p: Principal, opts: { profile?: string | null } = {}) {
    const s = this.s();
    const profiles = await s.chat.profilesFor(p);
    const chosen = opts.profile ? (profiles.find((x) => x.name === opts.profile || x.id === opts.profile) ?? null) : (profiles[0] ?? null);
    if (opts.profile && !chosen) throw new HttpProblem(404, 'Not found', `Profile ${opts.profile} is not one you may pick.`);
    const caps = await s.chatInvocations.workspaceCapabilities(p, chosen?.name ?? null);
    const meta = await this.discoveryOf(p.tenantId);
    const reg = (kind: string, name: string, version: string) => meta.entries.get(`${kind}:${name}@${version}`);
    const out: CatalogEntry[] = [];
    const seen = new Set<string>();
    const push = (e: CatalogEntry) => {
      if (seen.has(e.key) || !clears(p.clearance, e.label)) return;
      seen.add(e.key);
      out.push(e);
    };
    for (const w of caps.workflows) {
      const d = meta.workflows.get(w.id);
      push(cardOf('workflow', { id: w.id, name: w.name, version: '', description: w.description, label: w.label, ...(d ?? {}) }));
    }
    for (const a of caps.agents) {
      const e = reg('agent', a.name, a.version);
      push(cardOf('agent', { id: e?.id ?? null, name: a.name, version: a.version, description: a.description, label: a.label, purpose: e?.purpose ?? null, examples: e?.examples ?? [], category: e?.category ?? null }));
    }
    for (const t of caps.tools) {
      const e = reg('tool', t.name, t.version);
      push(cardOf('tool', { id: e?.id ?? null, name: t.name, version: t.version, description: t.description, label: t.label, sideEffect: t.sideEffect, purpose: e?.purpose ?? null, examples: e?.examples ?? [], category: e?.category ?? (t.name === 'calculate' ? 'Built in' : null) }));
    }
    for (const k of caps.skills) {
      const e = reg('skill', k.name, k.version);
      push(cardOf('skill', { id: e?.id ?? null, name: k.name, version: k.version, description: k.description, label: k.label, purpose: e?.purpose ?? null, examples: e?.examples ?? [], category: e?.category ?? null }));
    }
    // What the allow-list hides: tools on other profiles the caller may pick, and skills outside this profile's list.
    if (chosen) {
      const others = profiles.filter((x) => x.name !== chosen.name);
      const offering = new Map<string, string[]>();
      for (const o of others) for (const t of o.tools) if (!caps.allow.tools.includes(t) && !(t === 'calculate' && caps.allow.calculate)) offering.set(t, [...(offering.get(t) ?? []), o.name]);
      if (offering.size && s.tools && caps.allow.profileResolved) {
        const names = [...offering.keys()].filter((n) => n !== 'calculate');
        if (offering.has('calculate')) push(cardOf('tool', { name: 'calculate', version: 'built-in', description: 'Exact arithmetic by the calculation worker.', label: 'public', sideEffect: 'read', category: 'Built in' }, { available: false, reason: 'not on this profile', profiles: offering.get('calculate')! }));
        const r = names.length ? await s.tools.resolve(p, names, 'public') : { tools: [] };
        for (const t of r.tools) {
          const e = reg('tool', t.entry.name, t.entry.version) ?? t.entry;
          push(cardOf('tool', { id: e.id, name: t.entry.name, version: t.entry.version, description: t.entry.description, label: t.entry.label, sideEffect: t.sideEffect, purpose: e.purpose ?? null, examples: e.examples ?? [], category: e.category ?? null }, { available: false, reason: 'not on this profile', profiles: offering.get(t.entry.name) ?? [] }));
        }
      }
      if (caps.allow.skills && caps.allow.profileResolved) {
        const rows = await s.gateway.repo.profiles(p.tenantId);
        const allowOf = new Map(rows.map((r) => [r.name, r.skills ?? null]));
        const listed = new Set(caps.skills.map((x) => x.name));
        const done = new Set<string>();
        for (const e of await s.registry.list(p.tenantId, { kind: 'skill' })) {
          if (!(e.status === 'published' || e.status === 'deprecated') || !s.registry.visibleTo(e, p) || listed.has(e.name) || done.has(e.name) || e.approved_hash !== e.schema_hash) continue;
          done.add(e.name);
          const offer = others.filter((o) => {
            const a = allowOf.get(o.name);
            return a === null || a === undefined || a.includes(e.name);
          });
          if (!offer.length) continue;
          push(cardOf('skill', { id: e.id, name: e.name, version: e.version, description: e.description, label: e.label, purpose: e.purpose ?? null, examples: e.examples ?? [], category: e.category ?? null }, { available: false, reason: 'not on this profile', profiles: offer.map((o) => o.name) }));
        }
      }
    }
    out.sort((a, b) => (a.category === b.category ? 0 : a.category === OTHER_CATEGORY ? 1 : b.category === OTHER_CATEGORY ? -1 : a.category.localeCompare(b.category)) || Number(b.available) - Number(a.available) || a.name.localeCompare(b.name));
    const categories = [...new Set(out.map((e) => e.category))].map((name) => ({ name, count: out.filter((e) => e.category === name).length }));
    const ws = p.workspaceId ? ((await this.db('workspaces').where({ tenant_id: p.tenantId, id: p.workspaceId }).first('id', 'name')) as { id: string; name: string } | undefined) : undefined;
    return {
      workspace: ws ? { id: ws.id, name: ws.name } : null,
      profile: chosen?.name ?? null,
      profiles: profiles.map((x) => ({ name: x.name, displayName: x.displayName })),
      clearance: p.clearance,
      entries: out,
      categories,
      counts: { available: out.filter((e) => e.available).length, notOnProfile: out.filter((e) => !e.available).length }
    };
  }

  // ---------- B-12304: the catalogue fields at submit ----------

  /** Is a registry entry offered in chat: an agent (`@`) or a skill (`+`) always, a tool once a published profile lists it. */
  async offeredInChat(e: EntryRow): Promise<boolean> {
    if (e.kind !== 'tool') return true;
    const profiles = await this.s().gateway.repo.profiles(e.tenant_id ?? '');
    return profiles.some((x) => x.status === 'published' && x.tools.includes(e.name));
  }

  /** Refuses a submit (422) naming the catalogue fields an entry offered in chat lacks. Older published entries are not touched. */
  async checkSubmit(e: EntryRow): Promise<void> {
    if (!this.s().cfg.REGISTRY_DISCOVERY_REQUIRED || !(await this.offeredInChat(e))) return;
    const missing = missingOf(e);
    if (!missing.length) return;
    const words: Record<string, string> = { purpose: 'a purpose', examples: 'at least one example prompt', category: 'a category' };
    const fields: Record<string, string> = { purpose: 'purpose', examples: 'example prompt', category: 'category' };
    throw new HttpProblem(422, 'Missing for the catalogue', `${e.name} ${e.version} is offered in chat, so the catalogue needs ${missing.map((m) => words[m]).join(', ')}. Missing: ${missing.map((m) => fields[m]).join(', ')}.`, { extensions: { missing, errors: missing.map((m) => ({ path: m, message: `Add ${words[m]}.` })) } });
  }

  /** The registry review's preview of an entry's catalogue card (B-12304). */
  previewCard(e: EntryRow): CatalogEntry {
    return cardOf(e.kind, { id: e.id, name: e.name, version: e.version, description: e.description, label: e.label, sideEffect: e.side_effect, purpose: e.purpose ?? null, examples: e.examples ?? [], category: e.category ?? null });
  }

  // ---------- B-12302: publish notices ----------

  async preferences(p: Principal): Promise<{ notices: NoticeMode; lastDigestAt: number | null; pending: number }> {
    const r = (await this.db('catalog_preferences').where({ tenant_id: p.tenantId, user_id: p.userId }).first()) as { notices: NoticeMode; last_digest_at: number | null } | undefined;
    const pending = (await this.db('catalog_notices').where({ tenant_id: p.tenantId, user_id: p.userId, state: 'pending' }).count({ n: '*' }).first()) as { n: number | string } | undefined;
    return { notices: r?.notices ?? 'each', lastDigestAt: r?.last_digest_at == null ? null : Number(r.last_digest_at), pending: Number(pending?.n ?? 0) };
  }

  /**
   * The person's choice for publish notices. Leaving the digest delivers what it held at once (as one digest) when
   * notices stay on, and drops it when they go off.
   */
  async setPreferences(p: Principal, notices: NoticeMode, meta: { ip?: string | null; traceId?: string } = {}) {
    const before = await this.preferences(p);
    const t = Date.now();
    const exists = await this.db('catalog_preferences').where({ tenant_id: p.tenantId, user_id: p.userId }).first('user_id');
    if (exists) await this.db('catalog_preferences').where({ tenant_id: p.tenantId, user_id: p.userId }).update({ notices, updated_at: t, ...(notices === 'digest' && before.notices !== 'digest' ? { last_digest_at: t } : {}) });
    else await this.db('catalog_preferences').insert({ tenant_id: p.tenantId, user_id: p.userId, notices, last_digest_at: notices === 'digest' ? t : null, updated_at: t });
    if (notices === 'each' && before.pending) await this.deliverDigest(p.tenantId, p.userId, t, false);
    if (notices === 'off' && before.pending) await this.db('catalog_notices').where({ tenant_id: p.tenantId, user_id: p.userId, state: 'pending' }).update({ state: 'skipped' });
    await this.s().audit.append({ tenantId: p.tenantId, action: 'catalog.preferences.updated', kind: 'admin', actor: actorFrom(p, meta.ip ?? undefined), target: { user: p.userId }, detail: { from: before.notices, to: notices }, ...(meta.traceId ? { traceId: meta.traceId } : {}) });
    return this.preferences(p);
  }

  /**
   * Notifies the members an entry was published (or newly offered) to, once each: members of the named workspaces
   * (every active user of the tenant for a tenant-wide entry) whose clearance reaches the entry's label, except the
   * people in `exclude` (who published it). Each person's choice applies: a notice now, a row for the weekly digest,
   * or nothing. Returns how many were notified, queued for a digest and skipped.
   */
  async announce(tenantId: string, item: { kind: CatalogKind; name: string; version: string | null; label: Label; description: string | null; scope: 'tenant' | string[]; exclude?: (string | null)[] }) {
    const s = this.s();
    const key = keyOf(item.kind, item.name);
    let users: { id: string; clearance: Label }[];
    if (item.scope === 'tenant') {
      users = (await this.db('users').where({ tenant_id: tenantId, state: 'active' }).select('id', 'clearance')) as { id: string; clearance: Label }[];
    } else {
      const by = new Map<string, Label>();
      for (const ws of item.scope) for (const m of await s.tenants.members(ws)) if (m.state === 'active') by.set(m.user_id, m.clearance);
      users = [...by].map(([id, clearance]) => ({ id, clearance }));
    }
    const exclude = new Set((item.exclude ?? []).filter((x): x is string => !!x));
    const eligible = users.filter((u) => clears(u.clearance, item.label) && !exclude.has(u.id)).map((u) => u.id);
    const result = { notified: 0, digest: 0, skipped: 0 };
    if (!eligible.length) return result;
    const prefs = new Map<string, NoticeMode>();
    for (let i = 0; i < eligible.length; i += 500) for (const r of (await this.db('catalog_preferences').where({ tenant_id: tenantId }).whereIn('user_id', eligible.slice(i, i + 500)).select('user_id', 'notices')) as { user_id: string; notices: NoticeMode }[]) prefs.set(r.user_id, r.notices);
    // Claim the (person, entry) rows first: whoever inserts a row sends its notice, so a notice goes out once.
    const t = Date.now();
    const ids = new Map<string, string>();
    const rows = eligible.map((u) => {
      const id = ulid();
      ids.set(id, u);
      const mode = prefs.get(u) ?? 'each';
      return { id, tenant_id: tenantId, user_id: u, entry_key: key, entry_kind: item.kind, entry_name: item.name, version: item.version, label: item.label, state: mode === 'each' ? 'claimed' : mode === 'digest' ? 'pending' : 'skipped', notification_id: null, created_at: t, sent_at: null };
    });
    for (let i = 0; i < rows.length; i += 200) await this.db('catalog_notices').insert(rows.slice(i, i + 200)).onConflict(['tenant_id', 'user_id', 'entry_key']).ignore();
    const mine = (await this.db('catalog_notices').whereIn('id', [...ids.keys()]).select('id', 'user_id', 'state')) as { id: string; user_id: string; state: string }[];
    const now = mine.filter((r) => r.state === 'claimed');
    result.digest = mine.filter((r) => r.state === 'pending').length;
    result.skipped = mine.filter((r) => r.state === 'skipped').length;
    if (now.length) {
      const sent = await s.notifications.notify({ tenantId, userIds: now.map((r) => r.user_id), kind: 'catalog', title: `${KIND_WORD[item.kind]} ${item.name} is now available to you`, ...(item.description ? { body: item.description.slice(0, 300) } : {}), route: `catalog?entry=${encodeURIComponent(key)}`, label: item.label });
      const byUser = new Map(sent.map((n) => [n.user_id, n.id]));
      for (const r of now) await this.db('catalog_notices').where({ id: r.id }).update({ state: 'sent', notification_id: byUser.get(r.user_id) ?? null, sent_at: Date.now() });
      result.notified = now.length;
    }
    if (mine.length) await s.audit.append({ tenantId, action: 'catalog.notices.sent', kind: 'system', actor: { service: 'catalogue' }, target: { entry: key, version: item.version }, label: item.label, detail: result });
    return result;
  }

  /** One person's pending digest rows as one notification (the high-water label of what it lists). */
  private async deliverDigest(tenantId: string, userId: string, now: number, weekly = true): Promise<number> {
    const pending = (await this.db('catalog_notices').where({ tenant_id: tenantId, user_id: userId, state: 'pending' }).orderBy('created_at')) as { id: string; entry_key: string; entry_kind: CatalogKind; entry_name: string; label: Label }[];
    if (!pending.length) return 0;
    const names = pending.map((r) => `${KIND_WORD[r.entry_kind].toLowerCase()} ${r.entry_name}`);
    const [n] = await this.s().notifications.notify({ tenantId, userIds: [userId], kind: 'catalog', title: `${weekly ? 'This week: ' : ''}${pending.length === 1 ? `${names[0]} is now available to you` : `${pending.length} new things you can use`}`, body: names.slice(0, 8).join(', ') + (names.length > 8 ? `, and ${names.length - 8} more` : ''), route: pending.length === 1 ? `catalog?entry=${encodeURIComponent(pending[0]!.entry_key)}` : 'catalog', label: highest(...pending.map((r) => r.label)) });
    await this.db('catalog_notices').whereIn('id', pending.map((r) => r.id)).update({ state: 'sent', notification_id: n?.id ?? null, sent_at: now });
    return pending.length;
  }

  /** The weekly digest (the `catalog.digest` job): every person on the digest whose last one is a week old. */
  async sendDigests(tenantId: string, now = Date.now()): Promise<{ digests: number; entries: number }> {
    const due = (await this.db('catalog_preferences').where({ tenant_id: tenantId, notices: 'digest' })) as { user_id: string; last_digest_at: number | null; updated_at: number }[];
    let digests = 0;
    let entries = 0;
    for (const r of due) {
      const since = Number(r.last_digest_at ?? r.updated_at);
      if (now - since < DIGEST_MS) continue;
      const n = await this.deliverDigest(tenantId, r.user_id, now);
      await this.db('catalog_preferences').where({ tenant_id: tenantId, user_id: r.user_id }).update({ last_digest_at: now });
      if (n) {
        digests++;
        entries += n;
      }
    }
    if (digests) await this.s().audit.append({ tenantId, action: 'catalog.digest.sent', kind: 'system', actor: { service: 'catalogue' }, target: { digests }, detail: { entries } });
    return { digests, entries };
  }

  registerJobs(): void {
    const s = this.s();
    s.jobs.register('catalog.digest', async (payload, ctx) => this.sendDigests(String(payload.tenantId ?? ctx.job.tenant_id)));
  }

  // ---------- B-12303: composer suggestions ----------

  /** Entry vectors under one model, cached per entry version and recomputed when the text they came from changed. */
  private async vectors(tenantId: string, model: string, label: Label, entries: CatalogEntry[], userId: string): Promise<Map<string, number[]>> {
    const s = this.s();
    const out = new Map<string, number[]>();
    if (!entries.length) return out;
    const rows = (await this.db('catalog_vectors').where({ tenant_id: tenantId, model }).whereIn('entry_key', entries.map((e) => e.key))) as { entry_key: string; version: string; text_hash: string; vector: string }[];
    const todo: { e: CatalogEntry; text: string; h: string }[] = [];
    for (const e of entries) {
      const text = textOf(e);
      const h = hash(text);
      const r = rows.find((x) => x.entry_key === e.key && x.version === (e.version || '-'));
      if (r && r.text_hash === h) out.set(e.key, decodeVector(r.vector));
      else todo.push({ e, text, h });
    }
    if (todo.length) {
      const r = await s.gateway.embed(model, todo.map((x) => x.text), label);
      await s.quotas.record({ tenantId, workspaceId: null, userId, kind: 'embed', model, poolId: r.poolId, promptTokens: r.promptTokens, gpuMs: r.gpuMs });
      const t = Date.now();
      for (const [i, x] of todo.entries()) {
        const v = r.embeddings[i]!;
        out.set(x.e.key, v);
        await this.db('catalog_vectors').where({ tenant_id: tenantId, entry_key: x.e.key, version: x.e.version || '-', model }).delete();
        await this.db('catalog_vectors').insert({ tenant_id: tenantId, entry_key: x.e.key, version: x.e.version || '-', model, text_hash: x.h, vector: encodeVector(v), created_at: t });
      }
    }
    return out;
  }

  /** The suggestions a person dismissed in a conversation. */
  async dismissed(p: Principal, conversationId: string): Promise<string[]> {
    return ((await this.db('catalog_dismissals').where({ tenant_id: p.tenantId, conversation_id: conversationId, user_id: p.userId }).select('entry_key')) as { entry_key: string }[]).map((r) => r.entry_key);
  }

  /** A dismissed suggestion stays away for the rest of the conversation. */
  async dismiss(p: Principal, conversationId: string, key: string, meta: { ip?: string | null; traceId?: string } = {}): Promise<{ dismissed: string[] }> {
    const s = this.s();
    const c = await s.chat.conversation(p, conversationId);
    if (c.user_id !== p.userId) throw new HttpProblem(403, 'Forbidden', 'Only the conversation\'s owner dismisses its suggestions.', { extensions: { step: 'role' } });
    await this.db('catalog_dismissals').insert({ tenant_id: p.tenantId, conversation_id: c.id, user_id: p.userId, entry_key: key, created_at: Date.now() }).onConflict(['conversation_id', 'entry_key']).ignore();
    await s.audit.append({ tenantId: p.tenantId, action: 'chat.suggestion.dismissed', kind: 'decision', actor: actorFrom(p, meta.ip ?? undefined), target: { conversation: c.id, entry: key }, label: c.label, ...(meta.traceId ? { traceId: meta.traceId } : {}) });
    return { dismissed: await this.dismissed(p, c.id) };
  }

  /**
   * Up to three entries the conversation (or, before one exists, the workspace through `profile`) may call whose
   * name, description, purpose and examples are closest to the draft, ranked by the embedding profile's vectors, above
   * `DISCOVERY_SUGGEST_MIN_SCORE`, without the ones dismissed in the conversation. `off` says why nothing is offered:
   * the profile has suggestions off, or there is no usable embedding profile.
   */
  async suggest(p: Principal, input: { draft: string; profile?: string | null; conversationId?: string | null; dismissed?: string[] }) {
    const s = this.s();
    const draft = input.draft.trim();
    type Out = { suggestions: (Pick<CatalogEntry, 'key' | 'kind' | 'name' | 'description' | 'example' | 'call' | 'compose' | 'category' | 'sideEffect' | 'label'> & { score: number })[]; off: null | 'profile' | 'embedding'; detail: string | null; dismissed: string[] };
    let label: Label = 'public';
    let caps: Awaited<ReturnType<typeof s.chatInvocations.capabilities>>;
    let dismissed = [...(input.dismissed ?? [])];
    if (input.conversationId) {
      const c = await s.chat.conversation(p, input.conversationId);
      label = c.label;
      caps = await s.chatInvocations.capabilities(p, c.id);
      if (!caps.profile && input.profile) caps = { ...(await s.chatInvocations.workspaceCapabilities(p, input.profile)), label: c.label, active: caps.active };
      dismissed = [...new Set([...dismissed, ...(await this.dismissed(p, c.id))])];
    } else {
      caps = await s.chatInvocations.workspaceCapabilities(p, input.profile ?? null);
    }
    const out: Out = { suggestions: [], off: null, detail: null, dismissed };
    const profileName = caps.profile ?? input.profile ?? null;
    if (profileName) {
      const row = await s.gateway.repo.profileByName(p.tenantId, profileName);
      if (row && row.suggestions === false) return { ...out, off: 'profile' as const, detail: `Profile ${profileName} has composer suggestions off.` };
    }
    let model: string;
    try {
      const r = await s.gateway.resolve(p.tenantId, s.cfg.DISCOVERY_EMBED_PROFILE);
      if (!r.model.capabilities.includes('embedding')) return { ...out, off: 'embedding' as const, detail: `Profile ${r.profile.name} does not route to an embedding model.` };
      if (labelRank(label) > labelRank(r.profile.label)) return { ...out, off: 'embedding' as const, detail: `Profile ${r.profile.name} handles data up to ${r.profile.label}; this conversation is ${label}.` };
      model = r.model.name;
    } catch {
      return { ...out, off: 'embedding' as const, detail: `No embedding profile ${s.cfg.DISCOVERY_EMBED_PROFILE} is published; suggestions need one.` };
    }
    if (draft.length < 3) return out;
    const meta = await this.discoveryOf(p.tenantId);
    const reg = (kind: string, name: string, version: string) => meta.entries.get(`${kind}:${name}@${version}`);
    const candidates: CatalogEntry[] = [
      ...caps.workflows.map((w) => cardOf('workflow', { id: w.id, name: w.name, version: '', description: w.description, label: w.label, ...(meta.workflows.get(w.id) ?? {}) })),
      ...caps.agents.map((a) => cardOf('agent', { name: a.name, version: a.version, description: a.description, label: a.label, ...pick(reg('agent', a.name, a.version)) })),
      ...caps.tools.map((t) => cardOf('tool', { name: t.name, version: t.version, description: t.description, label: t.label, sideEffect: t.sideEffect, ...pick(reg('tool', t.name, t.version)) })),
      ...caps.skills.map((k) => cardOf('skill', { name: k.name, version: k.version, description: k.description, label: k.label, ...pick(reg('skill', k.name, k.version)) }))
    ].filter((e) => clears(p.clearance, e.label) && !dismissed.includes(e.key));
    if (!candidates.length) return out;
    const vecs = await this.vectors(p.tenantId, model, label, candidates, p.userId);
    const q = await s.gateway.embed(model, [draft], label);
    await s.quotas.record({ tenantId: p.tenantId, workspaceId: p.workspaceId ?? null, userId: p.userId, kind: 'embed', model, poolId: q.poolId, promptTokens: q.promptTokens, gpuMs: q.gpuMs });
    const qv = q.embeddings[0]!;
    const min = s.cfg.DISCOVERY_SUGGEST_MIN_SCORE;
    out.suggestions = candidates
      .map((e) => ({ e, score: cosine(qv, vecs.get(e.key) ?? []) }))
      .filter((x) => x.score >= min)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_SUGGESTIONS)
      .map(({ e, score }) => ({ key: e.key, kind: e.kind, name: e.name, description: e.description, example: e.example, call: e.call, compose: e.compose, category: e.category, sideEffect: e.sideEffect, label: e.label, score: Math.round(score * 1000) / 1000 }));
    return out;
  }
}

const pick = (e: EntryRow | undefined): Partial<Discovery> & { id?: string } => (e ? { id: e.id, purpose: e.purpose ?? null, examples: e.examples ?? [], category: e.category ?? null } : {});

/** The catalogue fields an author fills (B-12304), as the registry and workflow routes accept them. */
export const discoveryFields = {
  purpose: z.string().trim().max(500).nullable().optional(),
  examples: z.array(z.string().trim().min(1).max(300)).max(5).optional(),
  category: z.string().trim().min(1).max(60).nullable().optional()
};
