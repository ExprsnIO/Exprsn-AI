import { HttpProblem, tooManyRequests } from '../http/problem.js';
import { scrubSecrets } from '../platform/diagnostics.js';
import type { Services } from '../services.js';
import type { CloudActor } from './accounts.js';
import {
  FEATURE_NAMES,
  FEATURES_BY_PROVIDER,
  PROVIDER_NAMES,
  type CloudAccount,
  type CloudFeature,
  type CredentialPurpose,
  type FeatureReport,
  type IdentityResult,
  type PermissionCheck,
  type ValidationReport
} from './types.js';

/*
 * 1.9.99-final, Sprint 56 (B-10007, B-10009): validating a cloud account. `POST /api/admin/cloud/accounts/:id/validate`
 * buys a credential for the account (`s.cloud.credentials.for(account, 'validate')`), asks the provider who it is
 * (STS GetCallerIdentity, the ARM subscription, DigitalOcean `/v2/account`, Cloudflare `/user/tokens/verify`) and then
 * checks the actions each feature needs, reporting what is missing per feature. The report is kept on the account,
 * whose state moves between `active` and `attention`; features with something missing are refused by
 * `CloudAccounts.assertFeature` with the missing permission named.
 *
 * Provider calls happen only inside the adapters (`cloud/providers/`), through the egress checks and the rate limiter.
 * A provider error answers 502 with the provider's request id; a throttled call 429 with its retry time. Neither
 * replaces the last good report.
 */

/** What validation needs from the credentials module (B owns `cloud/credentials.ts`). */
export interface CredentialSource {
  for(account: CloudAccount, purpose: CredentialPurpose): Promise<unknown>;
}

/** What validation needs from a provider adapter (C owns `cloud/providers/`). */
export interface ValidatingProvider {
  identity(cred: never, account: CloudAccount): Promise<IdentityResult>;
  checkPermissions(cred: never, account: CloudAccount, features: CloudFeature[]): Promise<PermissionCheck[]>;
}

const unavailable = (what: string) => new HttpProblem(503, 'Not available', `${what} is not available in this build, so the account cannot be validated yet.`, { extensions: { reason: 'cloud_component_missing' } });

/** The provider's account id the credential must belong to, per provider. */
function expectedAccount(a: CloudAccount): string | undefined {
  const ids = a.providerIds;
  return a.provider === 'aws' ? ids.awsAccountId : a.provider === 'azure' ? ids.azureSubscriptionId : a.provider === 'digitalocean' ? ids.doTeamId : ids.cloudflareAccountId;
}

function featureReport(account: CloudAccount, feature: CloudFeature, check: PermissionCheck | undefined): FeatureReport {
  const name = FEATURE_NAMES[feature];
  if (!check) return { feature, name, status: 'error', required: [], missing: [], reason: 'The provider did not report on this feature.' };
  if (check.unsupported) return { feature, name, status: 'unsupported', required: check.required, missing: [], reason: `${PROVIDER_NAMES[account.provider]} offers no ${name}.` };
  if (check.error) return { feature, name, status: 'error', required: check.required, missing: check.missing, reason: check.error };
  if (check.missing.length) return { feature, name, status: 'missing', required: check.required, missing: check.missing, reason: `Missing ${check.missing.join(', ')}: ${name} is disabled until the credential grants ${check.missing.length === 1 ? 'it' : 'them'}.` };
  return { feature, name, status: 'ok', required: check.required, missing: [], reason: null };
}

export class CloudValidation {
  constructor(private readonly s: () => Services) {}

  /** Builds the report from the adapter's answers (exported for the tests and the console's wording). */
  static report(account: CloudAccount, identity: IdentityResult, checks: PermissionCheck[], at = Date.now()): ValidationReport {
    const expected = expectedAccount(account);
    let id = identity;
    if (id.ok && expected && id.providerAccount && id.providerAccount !== expected) {
      id = { ...id, ok: false, error: `The credential belongs to ${id.providerAccount}, not to ${expected}.` };
    }
    const features = FEATURES_BY_PROVIDER[account.provider].map((f) =>
      id.ok ? featureReport(account, f, checks.find((c) => c.feature === f)) : { feature: f, name: FEATURE_NAMES[f], status: 'error' as const, required: [], missing: [], reason: 'The identity check failed, so nothing else was checked.' }
    );
    return { at, ok: id.ok && features.every((f) => f.status === 'ok' || f.status === 'unsupported'), identity: id, features };
  }

  async validate(a: CloudActor, accountId: string): Promise<{ account: CloudAccount; report: ValidationReport }> {
    const s = this.s();
    const accounts = s.cloud.accounts;
    const account = await accounts.getFor(a.principal, accountId);
    accounts.assertCanChange(a.principal, account);
    if (account.state === 'disabled') throw new HttpProblem(409, 'Conflict', `${account.name} is disabled; enable it before validating.`);
    const credentials = s.cloud.credentials as CredentialSource | undefined;
    if (!credentials) throw unavailable('Cloud credentials');
    const provider = s.cloud.providerFor(account.provider) as ValidatingProvider | null;
    if (!provider) throw unavailable(`The ${PROVIDER_NAMES[account.provider]} adapter`);
    let identity: IdentityResult;
    let checks: PermissionCheck[] = [];
    try {
      const cred = (await credentials.for(account, 'validate')) as never;
      identity = await provider.identity(cred, account);
      if (identity.ok) checks = await provider.checkPermissions(cred, account, [...FEATURES_BY_PROVIDER[account.provider]]);
    } catch (err) {
      throw providerProblem(account, err);
    }
    const report = CloudValidation.report(account, identity, checks);
    return { account: await accounts.recordValidation(a, account, report), report };
  }
}

/** A provider failure as a problem: 429 with the retry time when throttled, else 502 with the provider's request id. */
export function providerProblem(account: CloudAccount, err: unknown): HttpProblem {
  if (err instanceof HttpProblem) return err;
  const e = (err ?? {}) as { message?: string; status?: number; statusCode?: number; retryAfter?: number; retryAfterSeconds?: number; requestId?: string };
  const status = e.status ?? e.statusCode;
  const retry = e.retryAfterSeconds ?? e.retryAfter;
  const name = PROVIDER_NAMES[account.provider];
  if (status === 429 || retry != null) {
    const p = tooManyRequests(`${name} is rate limiting this account; validation waits and retries. Nothing is lost.`, retry ?? 30);
    if (e.requestId) Object.assign(p.extensions, { provider_request_id: e.requestId });
    return p;
  }
  return new HttpProblem(502, 'Provider error', `${name} answered ${status ?? 'with an error'} while validating ${account.name}: ${scrubSecrets(e.message ?? 'no detail').slice(0, 300)}. The account keeps its last good validation.`, { extensions: { reason: 'provider_error', ...(e.requestId ? { provider_request_id: e.requestId } : {}) } });
}
