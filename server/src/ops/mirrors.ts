import { ulid } from 'ulid';
import { fetch as undiciFetch } from 'undici';
import { checkUrl, guardedAgent, parseAllowList, type AllowList } from '../mcp/hosts.js';
import { isUniqueViolation } from '../audit/chain.js';
import { conflict, notFound, badRequest } from '../http/problem.js';
import type { Services } from '../services.js';
import { audit, type OpsActor } from './common.js';

export const MIRROR_KINDS = ['images', 'npm', 'pypi', 'trivy', 'models', 'apt', 'tofu'] as const;
export type MirrorKind = (typeof MIRROR_KINDS)[number];

/** How a bundle's contents summary names each kind. */
export const KIND_NOUN: Record<MirrorKind, [string, string]> = {
  images: ['image', 'images'],
  npm: ['npm package', 'npm'],
  pypi: ['wheel', 'wheels'],
  trivy: ['Trivy DB', 'Trivy DB files'],
  models: ['model', 'models'],
  apt: ['OS package', 'OS packages'],
  tofu: ['provider', 'providers']
};

export interface MirrorRow {
  id: string;
  name: string;
  kind: MirrorKind;
  store: string;
  url: string;
  consumer: string | null;
  max_age_days: number | null;
  last_bundle: string | null;
  last_promoted_at: number | null;
  last_check_at: number | null;
  last_check_ok: boolean | null;
  last_check_detail: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface MirrorInput {
  name: string;
  kind: MirrorKind;
  store: string;
  url: string;
  consumer?: string | null;
  maxAgeDays?: number | null;
}

const fromRow = (r: Record<string, unknown>): MirrorRow => ({
  ...(r as unknown as MirrorRow),
  max_age_days: r.max_age_days == null ? null : Number(r.max_age_days),
  last_promoted_at: r.last_promoted_at == null ? null : Number(r.last_promoted_at),
  last_check_at: r.last_check_at == null ? null : Number(r.last_check_at),
  last_check_ok: r.last_check_ok == null ? null : Boolean(r.last_check_ok),
  created_at: Number(r.created_at),
  updated_at: Number(r.updated_at)
});

const DAY = 86_400_000;

/** Freshness and policy: dependency and database mirrors older than their limit are flagged; content-addressed ones never expire. */
export function mirrorPolicy(m: MirrorRow, now = Date.now()): { ageDays: number | null; policy: string; stale: boolean } {
  const ageDays = m.last_promoted_at == null ? null : Math.floor((now - m.last_promoted_at) / DAY);
  if (m.last_check_ok === false) return { ageDays, policy: 'unreachable', stale: false };
  if (m.max_age_days == null) return { ageDays, policy: 'ok', stale: false };
  if (ageDays == null) return { ageDays, policy: 'never promoted', stale: true };
  if (ageDays > m.max_age_days) return { ageDays, policy: `older than ${m.max_age_days} days`, stale: true };
  return { ageDays, policy: 'ok', stale: false };
}

export const mirrorView = (m: MirrorRow) => {
  const p = mirrorPolicy(m);
  let host: string | null;
  try {
    host = new URL(m.url).host;
  } catch {
    host = null;
  }
  return {
    id: m.id, name: m.name, kind: m.kind, store: m.store, url: m.url, host, consumer: m.consumer, maxAgeDays: m.max_age_days,
    lastBundle: m.last_bundle, lastPromotedAt: m.last_promoted_at, ageDays: p.ageDays, policy: p.policy, stale: p.stale,
    lastCheckAt: m.last_check_at, lastCheckOk: m.last_check_ok, lastCheckDetail: m.last_check_detail, createdAt: m.created_at, updatedAt: m.updated_at
  };
};

/** The registry of internal mirrors that promoted bundles feed. Every mirror URL must resolve to an internal address. */
export class MirrorService {
  constructor(private readonly s: () => Services) {}

  private get allow(): AllowList {
    return parseAllowList(this.s().cfg.PLATFORM_ALLOWED_HOSTS);
  }

  async list(): Promise<MirrorRow[]> {
    return (await this.s().db('platform_mirrors').orderBy('name')).map(fromRow);
  }

  async get(id: string): Promise<MirrorRow> {
    const r = await this.s().db('platform_mirrors').where({ id }).first();
    if (!r) throw notFound('Mirror');
    return fromRow(r);
  }

  async byKind(kind: MirrorKind): Promise<MirrorRow[]> {
    return (await this.s().db('platform_mirrors').where({ kind })).map(fromRow);
  }

  private async checkHost(url: string): Promise<void> {
    try {
      await checkUrl(url, this.allow);
    } catch (err) {
      throw badRequest((err as Error).message, { field: 'url' });
    }
  }

  async create(by: OpsActor, input: MirrorInput): Promise<MirrorRow> {
    await this.checkHost(input.url);
    const t = Date.now();
    const row = { id: ulid(), name: input.name, kind: input.kind, store: input.store, url: input.url, consumer: input.consumer ?? null, max_age_days: input.maxAgeDays === undefined ? (input.kind === 'models' ? null : 7) : input.maxAgeDays, created_by: by.userId, created_at: t, updated_at: t };
    try {
      await this.s().db('platform_mirrors').insert(row);
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`A mirror named ${input.name} exists.`);
      throw err;
    }
    await audit(this.s(), by, 'platform.mirror.created', { mirror: row.id, name: row.name }, { kind: row.kind, store: row.store, url: row.url, maxAgeDays: row.max_age_days }, 'admin');
    return this.get(row.id);
  }

  async update(by: OpsActor, id: string, patch: Partial<MirrorInput>): Promise<MirrorRow> {
    const before = await this.get(id);
    if (patch.url) await this.checkHost(patch.url);
    const u: Record<string, unknown> = { updated_at: Date.now() };
    if (patch.name !== undefined) u.name = patch.name;
    if (patch.kind !== undefined) u.kind = patch.kind;
    if (patch.store !== undefined) u.store = patch.store;
    if (patch.url !== undefined) u.url = patch.url;
    if (patch.consumer !== undefined) u.consumer = patch.consumer;
    if (patch.maxAgeDays !== undefined) u.max_age_days = patch.maxAgeDays;
    try {
      await this.s().db('platform_mirrors').where({ id }).update(u);
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`A mirror named ${String(patch.name)} exists.`);
      throw err;
    }
    const changed = Object.keys(u).filter((k) => k !== 'updated_at');
    await audit(this.s(), by, 'platform.mirror.updated', { mirror: id, name: before.name }, { changed, before: Object.fromEntries(changed.map((k) => [k, (before as unknown as Record<string, unknown>)[k]])), after: Object.fromEntries(changed.map((k) => [k, u[k]])) }, 'admin');
    return this.get(id);
  }

  async remove(by: OpsActor, id: string): Promise<void> {
    const m = await this.get(id);
    await this.s().db('platform_mirrors').where({ id }).delete();
    await audit(this.s(), by, 'platform.mirror.removed', { mirror: id, name: m.name }, { kind: m.kind, url: m.url }, 'admin');
  }

  /** Probes each mirror's URL (internal addresses only, checked at connect time too). Any HTTP answer below 500 counts as up. */
  async check(ids: string[] | null, progress?: (pct: number, msg: string) => Promise<void>, signal?: AbortSignal): Promise<{ id: string; name: string; ok: boolean; detail: string }[]> {
    const mirrors = (await this.list()).filter((m) => !ids || ids.includes(m.id));
    const agent = guardedAgent(this.allow, 5000);
    const out: { id: string; name: string; ok: boolean; detail: string }[] = [];
    try {
      for (const [i, m] of mirrors.entries()) {
        let ok = false;
        let detail: string;
        const started = Date.now();
        try {
          await checkUrl(m.url, this.allow);
          const res = await undiciFetch(m.url, { method: 'GET', dispatcher: agent, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000), redirect: 'manual' });
          await res.body?.cancel().catch(() => undefined);
          ok = res.status < 500;
          detail = `HTTP ${res.status} in ${Date.now() - started} ms`;
        } catch (err) {
          const e = err as Error & { cause?: Error };
          detail = (e.cause?.message ?? e.message).slice(0, 300);
        }
        await this.s().db('platform_mirrors').where({ id: m.id }).update({ last_check_at: Date.now(), last_check_ok: ok, last_check_detail: detail });
        out.push({ id: m.id, name: m.name, ok, detail });
        await progress?.(Math.round(((i + 1) * 100) / Math.max(1, mirrors.length)), `${m.name}: ${detail}`);
      }
    } finally {
      await agent.close().catch(() => undefined);
    }
    return out;
  }

  /** Records a promotion into every mirror of a kind. */
  async promoted(kind: MirrorKind, bundle: string, at: number): Promise<string[]> {
    const rows = await this.byKind(kind);
    if (rows.length) await this.s().db('platform_mirrors').where({ kind }).update({ last_bundle: bundle, last_promoted_at: at, updated_at: at });
    return rows.map((r) => r.name);
  }
}
