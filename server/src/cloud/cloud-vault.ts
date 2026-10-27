import { ulid } from 'ulid';
import type { Services } from '../services.js';
import type { KvData, VaultCaller } from '../vault/service.js';
import { parseVaultRef, SYS_SCOPE, sysPath } from '../vault/policy.js';

/*
 * 1.9.99-final, Sprint 56 (B-10006): where cloud credentials live in the vault.
 *
 * Every cloud secret (AWS access keys, an Azure client secret, a DigitalOcean or Cloudflare token, the keys a
 * publication target writes with) is a KV secret in the vault's platform scope (`SYS_SCOPE`), sealed under the
 * platform data key, at `cloud/accounts/<account>` or `cloud/issuer/<target>`, labelled `restricted`. The scope is
 * the platform's even for a tenant's own account: no tenant route lists or reads `sys/`, so a tenant admin's broad
 * grant in their own vault never reaches a cloud key, and no route returns one (decision recorded in docs/cloud.md).
 *
 * The one reader and writer is the service `cloud.credentials`, under a grant on `sys/kv/cloud` that this module makes
 * once (as `ensureSysHmacKey` does for the platform keys). Reads and writes are audited by the vault like any other,
 * with paths and versions, never values. With OpenBao KV chosen by the operator for the vault, the same calls land
 * there.
 */

export const CLOUD_SERVICE = 'cloud.credentials';
export const CLOUD_KV_ROOT = 'cloud';

export const accountPath = (accountId: string): string => `${CLOUD_KV_ROOT}/accounts/${accountId.toLowerCase()}`;
export const issuerTargetPath = (kind: string): string => `${CLOUD_KV_ROOT}/issuer/${kind.toLowerCase()}`;
export const refOf = (path: string, key: string): string => `vault:${path}#${key}`;

export class CloudVault {
  private granted = false;

  constructor(private readonly s: () => Services) {}

  caller(): VaultCaller {
    return this.s().vault.serviceCaller(CLOUD_SERVICE);
  }

  /** The grant that lets `cloud.credentials` use `sys/kv/cloud`, made once. */
  async ensureGrant(): Promise<void> {
    if (this.granted) return;
    const db = this.s().db;
    const path = sysPath(`kv/${CLOUD_KV_ROOT}`);
    const have = await db('vault_policies').where({ tenant_id: SYS_SCOPE, subject_kind: 'service', subject: CLOUD_SERVICE, path, effect: 'allow' }).first('id');
    if (!have) {
      const now = Date.now();
      try {
        await db('vault_policies').insert({ id: ulid(), tenant_id: SYS_SCOPE, subject_kind: 'service', subject: CLOUD_SERVICE, path, capabilities: JSON.stringify(['list', 'read', 'write', 'delete', 'destroy']), effect: 'allow', description: 'The cloud credentials service keeps the cloud accounts\' keys and tokens here (B-10006).', created_by: null, created_at: now, updated_at: now });
      } catch (err) {
        if (!(await db('vault_policies').where({ tenant_id: SYS_SCOPE, subject_kind: 'service', subject: CLOUD_SERVICE, path }).first('id'))) throw err;
      }
    }
    this.granted = true;
  }

  /** Writes a new version (the previous ones stay, up to the path's version limit) and returns the references. */
  async write(path: string, data: KvData): Promise<{ version: number; refs: Record<string, string> }> {
    await this.ensureGrant();
    const c = this.caller();
    const existing = await this.s().vault.secretAt(c, path);
    const out = await this.s().vault.write(c, path, data, existing ? {} : { label: 'restricted' });
    return { version: out.version, refs: Object.fromEntries(Object.keys(data).map((k) => [k, refOf(path, k)])) };
  }

  /** One value behind a reference. Only `cloud/` references of the platform scope resolve here. */
  async read(ref: string): Promise<string> {
    const parsed = parseVaultRef(ref);
    if (!parsed || !(parsed.path === CLOUD_KV_ROOT || parsed.path.startsWith(`${CLOUD_KV_ROOT}/`))) throw new Error('A cloud credential reference points under vault:cloud/.');
    await this.ensureGrant();
    return this.s().vault.readValue({ ...this.caller(), actor: { service: CLOUD_SERVICE, via: 'cloud.credentials' } }, ref);
  }

  /** Every value of the current version of a path. */
  async readAll(path: string): Promise<KvData> {
    await this.ensureGrant();
    return (await this.s().vault.read(this.caller(), path)).data;
  }

  /** The whole secret goes (every version), when its account is removed. */
  async remove(path: string): Promise<void> {
    await this.ensureGrant();
    const c = this.caller();
    if (await this.s().vault.secretAt(c, path)) await this.s().vault.deleteAll(c, path);
  }
}
