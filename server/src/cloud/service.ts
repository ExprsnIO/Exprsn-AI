import type { Services } from '../services.js';
import { CloudAccounts } from './accounts.js';
import { CloudBudgets } from './budgets.js';
import { CloudCertPush } from './cert-push.js';
import { CloudCaches } from './caches.js';
import { CloudDataTier } from './data-tier.js';
import { DbMoves } from './db-move.js';
import { CloudGpuPools } from './gpu-pools.js';
import { CloudAutoscale } from './autoscale.js';
import { CloudBedrock } from './bedrock.js';
import { CloudAiGateway } from './ai-gateway.js';
import { CloudModelImport } from './model-import.js';
import { CloudEdge } from './edge.js';
import { CloudModelPrices } from './model-prices.js';
import { CloudModelResidency } from './model-residency.js';
import { CloudDatabases } from './databases.js';
import { CloudCosts } from './costs.js';
import { CloudShowback } from './showback.js';
import { CloudAnomalies } from './anomalies.js';
import { CloudEngine } from './apply.js';
import { CloudDeployments } from './deployments.js';
import { CloudDiscovery } from './discovery.js';
import { CloudJournal } from './journal.js';
import { CloudPlans } from './planner.js';
import { CloudCredentials } from './credentials.js';
import type { EstimatePlanFn } from './graph.js';
import { CloudLifecycle } from './lifecycle.js';
import { CloudReleases } from './releases.js';
import { cloudTransportMetrics } from './limits-metrics.js';
import { CloudPrices } from './prices.js';
import { CloudModelCatalogue } from './model-catalogue.js';
import { CloudModelBackends } from './model-backends.js';
import { createProviderRegistry, type ProviderRegistry } from './providers/registry.js';
import type { Provider } from './types.js';
import { CloudValidation, type CredentialSource, type ValidatingProvider } from './validate.js';

/*
 * 1.9.99-final, Sprint 56: `s.cloud`, the cloud plane's services. Each part reads its collaborators lazily through
 * `s`. The accounts work owns `accounts` and `validation`; the credentials work adds `credentials`
 * (`cloud/credentials.ts`), and the provider adapters set `providerFor` (`cloud/providers/`). Until a part exists,
 * what needs it answers 503 `cloud_component_missing`.
 */
export interface CloudServices {
  /** B-10002, B-10008, B-10009: accounts, regions, ceilings, residency and their dual-controlled changes. */
  accounts: CloudAccounts;
  /** B-10007: the identity call and the per-feature permission check. */
  validation: CloudValidation;
  /** B-10003 to B-10006: `for(account, purpose)` buys the account's credential (set by `cloud/credentials.ts`). */
  credentials?: CredentialSource;
  /** B-10101: the adapter for a provider, or null when none is registered (set by `cloud/providers/`). */
  providerFor: (kind: Provider) => ValidatingProvider | null;
  /** B-10101: the four provider adapters (`cloud/providers/`), built on first use; building one calls nothing. */
  readonly providers: ProviderRegistry;
  /** B-10601: the price catalogue (`cloud/prices.ts`): API prices cached daily, the price sheet, estimates. */
  prices?: CloudPrices;
  /** B-10601: the planner's estimate hook (`prices.estimatePlan`). */
  estimatePlan?: EstimatePlanFn;
  /** B-10102: deployments and their resource graphs, the lease, refresh (`cloud/deployments.ts`). */
  deployments: CloudDeployments;
  /** B-10102: the append-only operation journal (`cloud/journal.ts`). */
  journal: CloudJournal;
  /** B-10103: plans, their hash and expiry, apply by hash (`cloud/planner.ts`). */
  plans: CloudPlans;
  /** B-10104, B-10105: the apply, poll and verify workers and their hooks (`cloud/apply.ts`, `cloud/verify.ts`). */
  engine: CloudEngine;
  /** B-10106, B-10107: drift, destroy and rollback, the orphan sweep (`cloud/lifecycle.ts`). */
  lifecycle: CloudLifecycle;
  /** B-10203, B-10207: Kubernetes releases (Helm), upgrades by image digest, pre-upgrade snapshots and their restores (`cloud/releases.ts`, `cloud/upgrades.ts`). */
  releases: CloudReleases;
  /** B-10602 (Sprint 58): budgets, their alerts, the hard stop and overrides (`cloud/budgets.ts`); `budgets.spend` is the `SpendSource`. */
  budgets: CloudBudgets;
  /** B-10206 (Sprint 58): renewed certificates pushed to cloud load balancers by the certificate hooks (`cloud/cert-push.ts`). */
  certPush: CloudCertPush;
  /** B-10301, B-10303, B-10307 (Sprint 59): managed databases: extension checks, snapshots with their cost, schedules, restore to a new instance (`cloud/databases.ts`). */
  databases: CloudDatabases;
  /** B-10603 (Sprint 59): billing ingestion into `cloud_costs`, estimate against actual (`cloud/costs.ts`). */
  costs: CloudCosts;
  /** B-10604 (Sprint 61): showback by tags and allocation rules, monthly per workspace and tenant, statement lines (`cloud/showback.ts`). */
  showback: CloudShowback;
  /** B-10606 (Sprint 62): daily spend per account and service against a robust 14-day baseline, alerts naming the top contributors (`cloud/anomalies.ts`). */
  anomalies: CloudAnomalies;
  /** B-10306 (Sprint 59): managed databases and stores discovered and connected as data connections (`cloud/discovery.ts`). */
  discovery: CloudDiscovery;
  /** B-10305 (Sprint 59): managed caches as REDIS_URL: compatibility, the URL in the vault (`cloud/caches.ts`). */
  caches: CloudCaches;
  /** B-10302, B-10305 (Sprint 59): a provisioned data tier wired into the deployed app (`cloud/data-tier.ts`). */
  dataTier: CloudDataTier;
  /** B-10302 (Sprint 59): moving this install onto a managed PostgreSQL, the read-only window (`cloud/db-move.ts`). */
  dbMoves: DbMoves;
  /** Sprint 60 (B-10502 to B-10504, B-10509): what each account offers as models, `listModels(account)` per provider (`cloud/model-catalogue.ts`). */
  modelCatalogue: CloudModelCatalogue;
  /** Sprint 60 (B-10502, B-10503, B-10509): Azure OpenAI, DigitalOcean GenAI and Workers AI as `kind: openai` instances, agents as tools, neurons (`cloud/model-backends.ts`). */
  modelBackends: CloudModelBackends;
  /** B-10401, B-10404, B-10405 (Sprint 60): GPU node groups and GPU VMs linked to gateway pools, node enrolment with Exprsn-AI CA certificates, warm-up from the model mirror, GPU quotas and capacity fallback (`cloud/gpu-pools.ts`). */
  gpuPools: CloudGpuPools;
  /** B-10402, B-10403, B-10605 (Sprint 60): scale-to-zero, autoscale, spot interruptions and idle GPU savings (`cloud/autoscale.ts`). */
  autoscale: CloudAutoscale;
  /** B-10501 (Sprint 60): Bedrock for AWS accounts: the `kind: bedrock` servers' backend, residency guard and the AWS lister (`cloud/bedrock.ts`). */
  bedrock: CloudBedrock;
  /** B-10908 (Sprint 61): Cloudflare AI Gateway in front of a cloud model instance: the hop, caching and logs by label, the gateway's own settings (`cloud/ai-gateway.ts`). */
  aiGateway: CloudAiGateway;
  /** B-10504 (Sprint 60): the cloud catalogue import: drafts with provider, account, region, terms and a capped ceiling (`cloud/model-import.ts`). */
  modelImport: CloudModelImport;
  /** B-10901 to B-10904 (Sprint 61): the Cloudflare front door: DNS and edge TLS, the tunnel, WAF and rate limits, Access (`cloud/edge.ts`). */
  edge: CloudEdge;
  /** B-10505 (Sprint 61): per-model prices, versioned by effective day, from the price APIs, the sheet or by hand; the one pricer of cloud usage records (`cloud/model-prices.ts`). */
  modelPrices: CloudModelPrices;
  /** B-10507 (Sprint 61): scope, regions and egress of cloud model calls, checked per request label; data-terms attestations under dual control (`cloud/model-residency.ts`). */
  modelResidency: CloudModelResidency;
}

export function createCloud(s: () => Services): CloudServices {
  let providers: ProviderRegistry | null = null;
  // B-10108: every adapter's transport reports its waits, outcomes and breaker changes to the Prometheus registry.
  const registry = () => (providers ??= createProviderRegistry(s().cfg, s().counters, undefined, cloudTransportMetrics(s().metrics.registry)));
  const prices = new CloudPrices(s);
  // B-10501, B-10504 (Sprint 60): the one model catalogue, with Bedrock's lister for AWS accounts.
  const modelCatalogue = new CloudModelCatalogue(s);
  const bedrock = new CloudBedrock(s);
  modelCatalogue.register('aws', bedrock.lister);
  return {
    modelCatalogue,
    bedrock,
    aiGateway: new CloudAiGateway(s),
    modelImport: new CloudModelImport(s),
    edge: new CloudEdge(s),
    modelPrices: new CloudModelPrices(s),
    modelResidency: new CloudModelResidency(s),
    prices,
    estimatePlan: prices.estimatePlan,
    accounts: new CloudAccounts(s),
    validation: new CloudValidation(s),
    credentials: new CloudCredentials(s),
    deployments: new CloudDeployments(s),
    journal: new CloudJournal(s),
    plans: new CloudPlans(s),
    engine: new CloudEngine(s),
    lifecycle: new CloudLifecycle(s),
    releases: new CloudReleases(s),
    budgets: new CloudBudgets(s),
    certPush: new CloudCertPush(s),
    databases: new CloudDatabases(s),
    costs: new CloudCosts(s),
    showback: new CloudShowback(s),
    anomalies: new CloudAnomalies(s),
    discovery: new CloudDiscovery(s),
    caches: new CloudCaches(s),
    dataTier: new CloudDataTier(s),
    dbMoves: new DbMoves(s),
    // One catalogue: the Bedrock lister (B-10501) is registered on it above, the Azure, DigitalOcean and Workers AI ones by `modelBackends`.
    modelBackends: new CloudModelBackends(s, modelCatalogue),
    gpuPools: new CloudGpuPools(s),
    autoscale: new CloudAutoscale(s),
    providerFor: (kind) => registry().providerFor(kind),
    get providers() {
      return registry();
    }
  };
}
