import { readFileSync } from 'node:fs';
import type { Config } from '../config/index.js';
import { assumeRoleWithWebIdentity } from '../cloud/aws-calls.js';
import { entraToken, type EntraToken } from '../cloud/azure-calls.js';
import { cloudHttp } from '../cloud/credential-http.js';
import type { ProviderCredential } from '../cloud/credentials.js';
import { CloudTransport } from '../cloud/providers/transport.js';
import { servicePolicy } from './egress.js';

/*
 * 1.9.99-final, Sprint 58 (B-10208): the identity a deployed install uses for its own key management and blob store.
 *
 * The KMS cannot take its credential from a cloud account in the console: those credentials live in the vault, and
 * the vault is sealed with data keys the KMS wraps. So the install's identity comes from its own environment, read
 * explicitly, and never from the instance metadata service (the egress guard refuses metadata addresses; nothing
 * here runs an SDK's default credential chain):
 *
 *   AWS    federated web identity: KMS_AWS_ROLE_ARN with KMS_AWS_WEB_IDENTITY_TOKEN_FILE (on EKS the projected
 *          service-account token, /var/run/secrets/eks.amazonaws.com/serviceaccount/token) → STS
 *          AssumeRoleWithWebIdentity, a session refreshed at two thirds of its life (the token file is read again each
 *          time, as the kubelet rotates it); or a vaulted key pair, KMS_AWS_ACCESS_KEY_ID with
 *          KMS_AWS_SECRET_ACCESS_KEY_FILE.
 *   Azure  workload identity: AZURE_IDENTITY_TENANT_ID, AZURE_IDENTITY_CLIENT_ID and AZURE_IDENTITY_FEDERATED_TOKEN_FILE
 *          (on AKS /var/run/secrets/azure/tokens/azure-identity-token) as the client assertion; or a client secret,
 *          AZURE_IDENTITY_CLIENT_SECRET_FILE. Tokens per scope (Key Vault, Storage), refreshed at two thirds.
 *
 * Both hand out the cloud epic's `ProviderCredential`. Production refuses the secrets inline (only their `_FILE`
 * forms, as for DATA_KEY). Values stay in these closures: never in a log line, an error or a row.
 */

export type AwsCredential = Extract<ProviderCredential, { kind: 'aws' }>;
export type AzureCredential = Extract<ProviderCredential, { kind: 'azure' }>;

export const KEY_VAULT_SCOPE = 'https://vault.azure.net/.default';
export const STORAGE_SCOPE = 'https://storage.azure.com/.default';

const readToken = (file: string, what: string): string => {
  let t: string;
  try {
    t = readFileSync(file, 'utf8').trim();
  } catch (err) {
    throw new Error(`${what} could not be read (${(err as NodeJS.ErrnoException).code ?? 'error'}).`, { cause: err });
  }
  if (!t) throw new Error(`${what} is empty.`);
  return t;
};

/** The install's AWS credential (KMS_AWS_*): a refreshed web identity session, or the vaulted key pair. */
export function awsInstallCredential(cfg: Config): () => Promise<AwsCredential> {
  let cached: { value: AwsCredential; refreshAt: number } | null = null;
  let inflight: Promise<AwsCredential> | null = null;
  return async () => {
    if (cfg.KMS_AWS_ROLE_ARN && cfg.KMS_AWS_WEB_IDENTITY_TOKEN_FILE) {
      if (cached && Date.now() < cached.refreshAt) return cached.value;
      if (inflight) return inflight;
      inflight = (async () => {
        const token = readToken(cfg.KMS_AWS_WEB_IDENTITY_TOKEN_FILE!, 'The web identity token file (KMS_AWS_WEB_IDENTITY_TOKEN_FILE)');
        const s = await assumeRoleWithWebIdentity(cloudHttp(cfg), cfg.KMS_AWS_STS_URL ?? cfg.CLOUD_AWS_STS_URL, { roleArn: cfg.KMS_AWS_ROLE_ARN!, token, sessionName: `exprsn-kms-${(cfg.INSTANCE_NAME ?? 'install').replace(/[^\w+=,.@-]/g, '-')}`.slice(0, 64), durationSeconds: cfg.CLOUD_SESSION_SECONDS });
        const issued = Date.now();
        const value: AwsCredential = { kind: 'aws', accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey, sessionToken: s.sessionToken, expiresAt: s.expiresAt };
        cached = { value, refreshAt: issued + Math.floor(((s.expiresAt - issued) * 2) / 3) };
        return value;
      })().finally(() => (inflight = null));
      return inflight;
    }
    if (cfg.KMS_AWS_ACCESS_KEY_ID && cfg.KMS_AWS_SECRET_ACCESS_KEY) return { kind: 'aws', accessKeyId: cfg.KMS_AWS_ACCESS_KEY_ID, secretAccessKey: cfg.KMS_AWS_SECRET_ACCESS_KEY, expiresAt: null };
    throw new Error('No AWS credential for the KMS: set KMS_AWS_ROLE_ARN with KMS_AWS_WEB_IDENTITY_TOKEN_FILE, or KMS_AWS_ACCESS_KEY_ID with KMS_AWS_SECRET_ACCESS_KEY_FILE.');
  };
}

/** The install's Azure credential (AZURE_IDENTITY_*): Entra tokens by workload identity or a client secret. */
export function azureInstallCredential(cfg: Config): AzureCredential {
  const tenantId = cfg.AZURE_IDENTITY_TENANT_ID ?? '';
  const clientId = cfg.AZURE_IDENTITY_CLIENT_ID ?? '';
  const tokens = new Map<string, { value: EntraToken; refreshAt: number }>();
  const inflight = new Map<string, Promise<EntraToken>>();
  return {
    kind: 'azure',
    tenantId,
    getToken: async (scope: string) => {
      if (scope !== KEY_VAULT_SCOPE && scope !== STORAGE_SCOPE) throw new Error(`The install's Azure identity hands out tokens for Key Vault and Storage only, not ${scope}.`);
      if (!tenantId || !clientId) throw new Error('No Azure identity: set AZURE_IDENTITY_TENANT_ID and AZURE_IDENTITY_CLIENT_ID.');
      const hit = tokens.get(scope);
      if (hit && Date.now() < hit.refreshAt) return hit.value;
      const running = inflight.get(scope);
      if (running) return running;
      const p = (async () => {
        const base = { tenantId, clientId, scope };
        let t: EntraToken;
        if (cfg.AZURE_IDENTITY_FEDERATED_TOKEN_FILE) t = await entraToken(cloudHttp(cfg), cfg.CLOUD_AZURE_AUTHORITY, { ...base, assertion: readToken(cfg.AZURE_IDENTITY_FEDERATED_TOKEN_FILE, 'The federated token file (AZURE_IDENTITY_FEDERATED_TOKEN_FILE)') });
        else if (cfg.AZURE_IDENTITY_CLIENT_SECRET) t = await entraToken(cloudHttp(cfg), cfg.CLOUD_AZURE_AUTHORITY, { ...base, secret: cfg.AZURE_IDENTITY_CLIENT_SECRET });
        else throw new Error('No Azure credential: set AZURE_IDENTITY_FEDERATED_TOKEN_FILE (workload identity) or AZURE_IDENTITY_CLIENT_SECRET_FILE.');
        const issued = Date.now();
        tokens.set(scope, { value: t, refreshAt: issued + Math.floor(((t.expiresAt - issued) * 2) / 3) });
        return t;
      })().finally(() => inflight.delete(scope));
      inflight.set(scope, p);
      return p;
    }
  };
}

/**
 * The cloud transport the install's KMS and blob store call through (rate limiter, breaker, egress guard, retries).
 * Its limits are well above the clouds' own for these APIs (KMS thousands a second, a storage account 20,000), so
 * the local limiter only smooths bursts; its counters are per process.
 */
export function installTransport(cfg: Config, provider: 'aws' | 'azure', maxBytes = 16 * 1024 * 1024): CloudTransport {
  const big = { points: 600_000, windowMs: 60_000 };
  return new CloudTransport({
    provider,
    policy: servicePolicy(cfg),
    limit: big,
    classLimits: { read: big, list: big, mutate: big, billing: big },
    timeoutMs: cfg.CLOUD_HTTP_TIMEOUT_MS,
    maxBytes,
    maxQueueWaitMs: 30_000
  });
}
