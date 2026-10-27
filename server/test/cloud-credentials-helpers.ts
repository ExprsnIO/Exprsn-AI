import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ulid } from 'ulid';
import { cloudCredentials, type CloudCredentials } from '../src/cloud/credentials.js';
import type { CloudAccount, CredentialMode, Provider, ProviderIds } from '../src/cloud/types.js';
import { startSigner } from '../src/signer/server.js';
import type { Harness } from './helpers.js';

/*
 * 1.9.99-final, Sprint 56 (B-10003 to B-10006): what the federation and credential suites share: the two migrations
 * applied by hand until they are registered, an account seeded straight into the tables (already approved: the dual
 * control is the accounts suite's), and a signer process so issuer keys never live in the test process.
 */

export async function installCloud(h: Harness): Promise<CloudCredentials> {
  if (!(await h.s.db.schema.hasTable('cloud_accounts'))) await (await import('../src/db/migrations/146_cloud_accounts.js')).up(h.s.db);
  if (!(await h.s.db.schema.hasTable('cloud_issuer_keys'))) await (await import('../src/db/migrations/147_cloud_federation.js')).up(h.s.db);
  h.s.cloud.accounts.resetSchemaCache();
  const c = cloudCredentials(h.s);
  // The installed checks are cached for a minute; a fresh instance sees the tables at once.
  (c as unknown as { installedAt: number }).installedAt = 0;
  (c.issuer as unknown as { installedAt: number }).installedAt = 0;
  return c;
}

export async function seedAccount(
  h: Harness,
  o: { provider: Provider; mode: CredentialMode; name?: string; providerIds: ProviderIds; params?: Record<string, string>; refs?: Record<string, string>; state?: CloudAccount['state']; scope?: 'platform' | 'tenant'; tenantId?: string | null; createdBy?: string | null }
): Promise<CloudAccount> {
  const id = ulid();
  const now = Date.now();
  const scope = o.scope ?? 'platform';
  const tenantId = scope === 'tenant' ? (o.tenantId ?? h.tenantId) : null;
  const region = { aws: 'eu-central-1', azure: 'westeurope', digitalocean: 'fra1', cloudflare: 'global' }[o.provider];
  await h.s.db('cloud_accounts').insert({ id, name: o.name ?? `${o.provider}-${id.slice(-6).toLowerCase()}`, provider: o.provider, scope, tenant_id: tenantId, scope_key: tenantId ?? 'platform', provider_ids: JSON.stringify(o.providerIds), credential_mode: o.mode, default_region: region, state: o.state ?? 'active', description: null, validation: null, validated_at: null, created_by: o.createdBy ?? null, created_tenant: h.tenantId, created_at: now, updated_at: now });
  await h.s.db('cloud_account_regions').insert({ account_id: id, region, zone: 'cloud-eu', ceiling: 'internal', geo: 'eu', is_default: true, updated_at: now });
  await h.s.db('cloud_credentials').insert({ account_id: id, mode: o.mode, params: JSON.stringify(o.params ?? {}), refs: JSON.stringify(o.refs ?? {}), updated_by: o.createdBy ?? null, updated_at: now });
  return (await h.s.cloud.accounts.get(id))!;
}

export async function signerFixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'exs-cloud-'));
  const socketPath = path.join(dir, 'run', 'signer.sock');
  const token = randomBytes(24).toString('base64url') + 'x'.repeat(8);
  const signer = await startSigner({ socketPath, key: randomBytes(32).toString('base64'), token });
  return {
    env: { DATA_KEY: '', SIGNER_SOCKET: socketPath, SIGNER_TOKEN: token },
    close: async () => {
      await signer.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/** Moves the clock for everything that reads Date.now (the code under test and the fakes). */
export function clock() {
  const real = Date.now.bind(Date);
  let offset = 0;
  const spy = (Date.now = () => real() + offset);
  return {
    advance(ms: number) {
      offset += ms;
    },
    restore() {
      if (Date.now === spy) Date.now = real;
    }
  };
}
