import { randomBytes } from 'node:crypto';
import { ulid } from 'ulid';
import { json, type Db } from '../db/knex.js';
import { hmac, randomToken, safeEqual } from '../crypto/index.js';
import type { Permission } from '../authz/permissions.js';

export interface ApiKeyRow {
  id: string;
  tenant_id: string;
  user_id: string;
  name: string;
  prefix: string;
  scopes: Permission[];
  expires_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
  created_at: number;
  /** Sprint 20 (B-1203): an Ed25519 public key (JWK x); when set, every `/v1` request with this key must be signed. */
  signature_key: string | null;
  /** 1.6.0 (B-7701): the agent identity the key was minted for; requests with it act as the agent on the owner's behalf. */
  agent_id: string | null;
}

const KEY_RE = /^exai_k1_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;

const toRow = (r: Record<string, unknown>): ApiKeyRow => ({
  id: String(r.id),
  tenant_id: String(r.tenant_id),
  user_id: String(r.user_id),
  name: String(r.name),
  prefix: String(r.prefix),
  scopes: json<Permission[]>(r.scopes, []),
  expires_at: Number(r.expires_at),
  last_used_at: r.last_used_at == null ? null : Number(r.last_used_at),
  revoked_at: r.revoked_at == null ? null : Number(r.revoked_at),
  created_at: Number(r.created_at),
  signature_key: r.signature_key == null ? null : String(r.signature_key),
  agent_id: r.agent_id == null ? null : String(r.agent_id)
});

export const apiKeyState = (k: ApiKeyRow): 'active' | 'expired' | 'revoked' =>
  k.revoked_at ? 'revoked' : k.expires_at <= Date.now() ? 'expired' : 'active';

/**
 * Personal API keys: `exai_k1_<prefix>_<secret>`. The full key is shown once; we keep the prefix (to find the row
 * and show it in lists) and HMAC(secret, key). A key's scopes are a subset of its owner's permissions at creation,
 * and are intersected with the owner's current roles on every request, so demoting a user demotes their keys.
 */
export class ApiKeyService {
  constructor(
    private readonly db: Db,
    private readonly secret: string
  ) {}

  private digest(key: string): string {
    return hmac(this.secret, 'apikey:' + key);
  }

  async create(input: { tenantId: string; userId: string; name: string; scopes: Permission[]; ttlDays: number; signatureKey?: string | null; agentId?: string | null }): Promise<{ key: string; row: ApiKeyRow }> {
    const prefix = randomBytes(6).toString('hex');
    const key = `exai_k1_${prefix}_${randomToken(32)}`;
    const t = Date.now();
    const row = {
      id: ulid(),
      tenant_id: input.tenantId,
      user_id: input.userId,
      name: input.name,
      prefix,
      secret_hash: this.digest(key),
      scopes: JSON.stringify([...new Set(input.scopes)].sort()),
      expires_at: t + input.ttlDays * 86400_000,
      last_used_at: null,
      revoked_at: null,
      created_at: t,
      signature_key: input.signatureKey ?? null,
      agent_id: input.agentId ?? null
    };
    await this.db('api_keys').insert(row);
    return { key, row: toRow(row) };
  }

  /** Resolves a presented key to its row if it is well-formed, matches, and is active. */
  async verify(key: string): Promise<ApiKeyRow | null> {
    const m = KEY_RE.exec(key);
    if (!m) return null;
    const r = await this.db('api_keys').where({ prefix: m[1] }).first();
    if (!r || !safeEqual(String(r.secret_hash), this.digest(key))) return null;
    const row = toRow(r);
    if (apiKeyState(row) !== 'active') return null;
    if (!row.last_used_at || Date.now() - row.last_used_at > 60_000) {
      await this.db('api_keys').where({ id: row.id }).update({ last_used_at: Date.now() });
    }
    return row;
  }

  /** 1.6.0 (B-7701): the keys minted for an agent identity (any owner); revoked and expired ones stay listed for 30 days. */
  async listForAgent(agentId: string): Promise<ApiKeyRow[]> {
    const cutoff = Date.now() - 30 * 86400_000;
    const rows = await this.db('api_keys')
      .where({ agent_id: agentId })
      .andWhere((w) => w.whereNull('revoked_at').orWhere('revoked_at', '>', cutoff))
      .andWhere('expires_at', '>', cutoff)
      .orderBy('created_at', 'desc');
    return rows.map(toRow);
  }

  async revokeForAgent(agentId: string, id: string): Promise<boolean> {
    return (await this.db('api_keys').where({ agent_id: agentId, id, revoked_at: null }).update({ revoked_at: Date.now() })) > 0;
  }

  /** Lists a user's keys (their personal ones, not those minted for agents); expired and revoked keys stay listed for 30 days. */
  async listForUser(userId: string): Promise<ApiKeyRow[]> {
    const cutoff = Date.now() - 30 * 86400_000;
    const rows = await this.db('api_keys')
      .where({ user_id: userId })
      .whereNull('agent_id')
      .andWhere((w) => w.whereNull('revoked_at').orWhere('revoked_at', '>', cutoff))
      .andWhere('expires_at', '>', cutoff)
      .orderBy('created_at', 'desc');
    return rows.map(toRow);
  }

  /** Sprint 20 (B-1203): sets or clears the public key that `/v1` requests made with this key must be signed with. */
  async setSignatureKey(userId: string, id: string, publicKey: string | null): Promise<ApiKeyRow | null> {
    const n = await this.db('api_keys').where({ user_id: userId, id, revoked_at: null }).update({ signature_key: publicKey });
    if (!n) return null;
    return toRow(await this.db('api_keys').where({ id }).first());
  }

  async revoke(userId: string, id: string): Promise<boolean> {
    return (await this.db('api_keys').where({ user_id: userId, id, revoked_at: null }).update({ revoked_at: Date.now() })) > 0;
  }

  async revokeAllForUser(userId: string): Promise<number> {
    return this.db('api_keys').where({ user_id: userId, revoked_at: null }).update({ revoked_at: Date.now() });
  }
}
