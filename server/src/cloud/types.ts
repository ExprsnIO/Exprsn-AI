import type { Label } from '../authz/labels.js';

/*
 * 1.9.99-final, Sprint 56 (B-10002, B-10007 to B-10009): the shared types of the cloud plane. Owned by the accounts
 * work (`cloud/accounts.ts`); the credentials (`cloud/credentials.ts`) and the provider adapters (`cloud/providers/`)
 * import from here and never redefine these.
 *
 * Nothing in this file talks to a provider.
 */

// ---------- providers and credential modes ----------

export const PROVIDERS = ['aws', 'azure', 'digitalocean', 'cloudflare'] as const;
export type Provider = (typeof PROVIDERS)[number];
export const isProvider = (v: unknown): v is Provider => typeof v === 'string' && (PROVIDERS as readonly string[]).includes(v);

export const PROVIDER_NAMES: Record<Provider, string> = { aws: 'AWS', azure: 'Azure', digitalocean: 'DigitalOcean', cloudflare: 'Cloudflare' };

/** `federated`: short-lived sessions bought with a token from Exprsn-AI's issuer. `vaulted`: a key or token held as a `vault:` reference. */
export const CREDENTIAL_MODES = ['federated', 'vaulted'] as const;
export type CredentialMode = (typeof CREDENTIAL_MODES)[number];

/** The modes each provider offers (B-10009: DigitalOcean and Cloudflare offer no federation). */
export const PROVIDER_MODES: Record<Provider, readonly CredentialMode[]> = {
  aws: ['federated', 'vaulted'],
  azure: ['federated', 'vaulted'],
  digitalocean: ['vaulted'],
  cloudflare: ['vaulted']
};

/** Why federation is unavailable for a provider, or null when it is offered. */
export function federationUnavailable(provider: Provider): string | null {
  if (provider === 'digitalocean') return 'DigitalOcean offers no workload identity federation: its API takes personal access tokens only, so the account uses a custom-scoped token held in the vault.';
  if (provider === 'cloudflare') return 'Cloudflare offers no workload identity federation: its API takes API tokens only, so the account uses a scoped API token (with the account id) held in the vault.';
  return null;
}

// ---------- accounts ----------

/** `platform`: owned by system admins (deploying Exprsn-AI, platform pools, the own database). `tenant`: one tenant's own account (B-100, open decision 6). */
export const ACCOUNT_SCOPES = ['platform', 'tenant'] as const;
export type AccountScope = (typeof ACCOUNT_SCOPES)[number];

/**
 * `pending`: added, waiting for a second cloud admin; unusable. `active`: usable. `attention`: usable, but the last
 * validation found something missing or failing. `disabled`: kept, unusable (set by an admin).
 */
export const ACCOUNT_STATES = ['pending', 'active', 'attention', 'disabled'] as const;
export type AccountState = (typeof ACCOUNT_STATES)[number];

/** What a tenant-scoped account may be used for (open decision 6); a platform account may be used for everything. */
export const ACCOUNT_USES = ['deploy', 'pools', 'database', 'data', 'models'] as const;
export type AccountUse = (typeof ACCOUNT_USES)[number];
export const TENANT_ACCOUNT_USES: readonly AccountUse[] = ['data', 'models'];

/** The provider's own ids for an account. Which apply depends on the provider (`PROVIDER_ID_FIELDS`). */
export interface ProviderIds {
  /** AWS: the 12-digit account id. */
  awsAccountId?: string;
  /** Azure: the Entra tenant id and the subscription id (GUIDs). */
  azureTenantId?: string;
  azureSubscriptionId?: string;
  /** DigitalOcean: the team's id (UUID). */
  doTeamId?: string;
  /** Cloudflare: the 32-hex account id and the zone ids it may touch. */
  cloudflareAccountId?: string;
  cloudflareZoneIds?: string[];
}

export const PROVIDER_ID_FIELDS: Record<Provider, { required: (keyof ProviderIds)[]; optional: (keyof ProviderIds)[] }> = {
  aws: { required: ['awsAccountId'], optional: [] },
  azure: { required: ['azureTenantId', 'azureSubscriptionId'], optional: [] },
  digitalocean: { required: ['doTeamId'], optional: [] },
  cloudflare: { required: ['cloudflareAccountId'], optional: ['cloudflareZoneIds'] }
};

/** A region on an account's allow-list, with the zone it maps to and its label ceiling (B-10008). */
export interface Region {
  region: string;
  /** The zone the region maps to (a `zones/` zone when one of that name is defined: its ceiling then caps this one). */
  zone: string;
  ceiling: Label;
  /** Residency geography: `eu`, `us`, `ca`, or `global` for Cloudflare's edge. */
  geo: string;
  isDefault: boolean;
}

/**
 * The credential of an account as stored: references and non-secret parameters only, never values (B-10006).
 * `params` holds what is not secret (an AWS role ARN, an Azure client id); `refs` maps each secret field to its
 * `vault:<path>#<key>` reference. A federated credential has no `refs`.
 */
export interface CloudCredentialRef {
  accountId: string;
  mode: CredentialMode;
  params: Record<string, string>;
  refs: Record<string, string>;
  updatedAt: number;
}

/** The parameters and references each provider and mode needs (validated when an account is added or its credential changes). */
export const CREDENTIAL_FIELDS: Record<Provider, Partial<Record<CredentialMode, { params: string[]; optionalParams?: string[]; refs: string[]; optionalRefs?: string[] }>>> = {
  aws: {
    federated: { params: ['roleArn'], refs: [] },
    vaulted: { params: [], refs: ['accessKeyId', 'secretAccessKey'] }
  },
  azure: {
    federated: { params: ['clientId'], refs: [] },
    // A client secret, or a certificate issued by the Exprsn-AI CA (its key held by the signer; B-10006).
    vaulted: { params: ['clientId'], refs: [], optionalRefs: ['clientSecret', 'certificate'] }
  },
  digitalocean: { vaulted: { params: [], refs: ['token'] } },
  cloudflare: { vaulted: { params: [], refs: ['token'] } }
};

export interface CloudAccount {
  id: string;
  /** Lower case, unique within its scope; used in tags (`exprsn:account`) and audit entries. Never changes. */
  name: string;
  provider: Provider;
  scope: AccountScope;
  /** The tenant of a tenant-scoped account; null for a platform account. */
  tenantId: string | null;
  providerIds: ProviderIds;
  credentialMode: CredentialMode;
  defaultRegion: string | null;
  state: AccountState;
  description: string | null;
  regions: Region[];
  /** The last validation's report, or null before the first. */
  validation: ValidationReport | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

// ---------- validation (B-10007) ----------

/** The features an account's credential is checked for, per provider (`FEATURES_BY_PROVIDER`). */
export const CLOUD_FEATURES = ['deploy', 'data', 'compute', 'models', 'billing', 'frontdoor', 'apptier'] as const;
export type CloudFeature = (typeof CLOUD_FEATURES)[number];

export const FEATURE_NAMES: Record<CloudFeature, string> = {
  deploy: 'Deploy (tagged resources)',
  data: 'Managed data',
  compute: 'GPU compute',
  models: 'Model backends',
  billing: 'Billing read',
  frontdoor: 'Front door (DNS, TLS, Tunnel, WAF)',
  apptier: 'App tier'
};

/** Cloudflare runs the edge and the app tier only (B-109): no GPU compute and no managed data beyond R2 and D1. */
export const FEATURES_BY_PROVIDER: Record<Provider, readonly CloudFeature[]> = {
  aws: ['deploy', 'data', 'compute', 'models', 'billing'],
  azure: ['deploy', 'data', 'compute', 'models', 'billing'],
  digitalocean: ['deploy', 'data', 'compute', 'models', 'billing'],
  cloudflare: ['frontdoor', 'apptier', 'data', 'models', 'billing']
};

/** What the provider adapter's `identity(cred, account)` answers (STS GetCallerIdentity, ARM subscription, /v2/account, /user/tokens/verify). */
export interface IdentityResult {
  ok: boolean;
  /** Who the provider says the credential is (an ARN, an object id, a team, a token id). */
  principal?: string;
  /** The provider account the credential belongs to, to compare with the account's provider ids. */
  providerAccount?: string;
  requestId?: string;
  error?: string;
}

/** What the provider adapter's `checkPermissions(cred, account, features)` answers for one feature. */
export interface PermissionCheck {
  feature: CloudFeature;
  /** Every action or permission the feature needs (IAM actions, ARM permissions, DigitalOcean scopes, Cloudflare permission groups). */
  required: string[];
  /** The ones the credential lacks; empty when the feature is usable. */
  missing: string[];
  /** Set when the provider offers nothing for the feature (B-10101 `unsupported`), or the check could not run. */
  unsupported?: boolean;
  error?: string;
}

export type FeatureStatus = 'ok' | 'missing' | 'unsupported' | 'error';

export interface FeatureReport {
  feature: CloudFeature;
  name: string;
  status: FeatureStatus;
  required: string[];
  missing: string[];
  /** Why the feature's actions are disabled, when they are. */
  reason: string | null;
}

export interface ValidationReport {
  at: number;
  ok: boolean;
  identity: IdentityResult;
  features: FeatureReport[];
}

/** What a credential is bought for; passed to `s.cloud.credentials.for(account, purpose)`. */
export type CredentialPurpose = 'validate' | 'read' | 'deploy' | 'billing';

/** What `s.cloud.credentials.for` answers (B-10003 to B-10006); defined in `cloud/credentials.ts`. */
export type { ProviderCredential } from './credentials.js';

// ---------- the dual-control proposals (B-10002, B-10008) ----------

export const CLOUD_PROPOSAL_KINDS = ['account.add', 'account.remove', 'account.credential', 'region.ceiling', 'residency'] as const;
export type CloudProposalKind = (typeof CLOUD_PROPOSAL_KINDS)[number];
export type ProposalState = 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'superseded';

export interface CloudProposal {
  id: string;
  kind: CloudProposalKind;
  /** The account it changes; null for a tenant's residency. */
  accountId: string | null;
  scope: AccountScope;
  tenantId: string | null;
  summary: string;
  /** References and settings only, never a secret value. */
  payload: Record<string, unknown>;
  state: ProposalState;
  proposedBy: string;
  proposedAt: number;
  decidedBy: string | null;
  decidedAt: number | null;
  note: string | null;
  /** Approving needs `platform:manage` too (a platform account, or a restricted ceiling). */
  needsPlatformAdmin: boolean;
}

/** Thrown shape of a refused placement: which check failed, for `policy.explain` and the problem's extensions. */
export interface RegionDecision {
  allow: boolean;
  step: 'region' | 'state' | 'use' | 'ceiling' | 'residency' | null;
  reason: string;
  region: string;
  zone: string | null;
  ceiling: Label | null;
}
