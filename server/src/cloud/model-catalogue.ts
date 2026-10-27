import { conflict, HttpProblem } from '../http/problem.js';
import type { Services } from '../services.js';
import type { CloudAccount, Provider } from './types.js';

/*
 * 1.9.99-final, Sprint 60 (B-10502, B-10503, B-10509; the listing B-10504's catalogue import is built over):
 * `s.cloud.modelCatalogue`, what each cloud account offers as models, before anything is registered.
 *
 *   Azure         the Azure OpenAI / AI Foundry deployments of every Cognitive Services account (`kind` OpenAI or
 *                 AIServices) in the subscription, through ARM (`Microsoft.CognitiveServices/accounts` and
 *                 `.../deployments`), each with its endpoint and the deployment name requests carry
 *   DigitalOcean  the serverless inference models (`GET /v1/models` on the inference endpoint) and the GenAI agents
 *                 (`GET /v2/gen-ai/agents`, listed as `kind: agent`, B-10503's registry tools)
 *   Cloudflare    the Workers AI models (`GET /accounts/<id>/ai/models/search`), text generation and embeddings
 *   AWS           Bedrock (`ListFoundationModels`, inference profiles), registered by the Bedrock work (B-10501)
 *
 * A provider's lister is registered with `register(provider, lister)`; `listModels(account)` asks the account's. Every
 * call goes through the provider adapter's transport (egress guard, rate limiter, breaker) with the account's
 * credential for purpose `read`. Nothing here writes to the catalogue: the import (B-10504) does.
 */

/** How a listed model is served once registered: which `kind: openai` flavour, or Bedrock's own server. */
export type CloudModelFlavour = 'azure' | 'digitalocean' | 'workers-ai' | 'bedrock';

export type CloudModelKind = 'chat' | 'embedding' | 'agent' | 'other';

/** One model (or Azure deployment, or DigitalOcean agent) an account offers. Never a secret. */
export interface CloudModelListing {
  provider: Provider;
  accountId: string;
  flavour: CloudModelFlavour;
  /** What requests name: the Azure deployment name, the DigitalOcean model id, the Workers AI model (`@cf/...`), the Bedrock model or profile id. */
  id: string;
  /** A display name (the underlying model for an Azure deployment). */
  name: string;
  kind: CloudModelKind;
  /** The region it runs in, when the provider says (Azure's location, a Bedrock region); null for global endpoints. */
  region: string | null;
  /** The base URL a `kind: openai` instance for it uses (the gateway adds the flavour's paths); null for Bedrock. */
  endpoint: string | null;
  /** The provider's own model under it (Azure: `gpt-4o` version `2024-08-06`), when known. */
  model?: { name: string; version?: string | null; format?: string | null } | null;
  /** Whether it can be used now (Bedrock model access, an Azure deployment that is not `Succeeded`). */
  available: boolean;
  reason?: string | null;
  /** Provider-specific facts the import shows (Azure SKU and capacity, the Cognitive Services account, a DO agent's id). */
  details?: Record<string, unknown>;
}

export interface CloudModelLister {
  listModels(account: CloudAccount, opts?: { signal?: AbortSignal }): Promise<CloudModelListing[]>;
}

/** Where the listers call (tests: the fakes). Defaults are the providers' public endpoints. */
export interface ModelCatalogueEndpoints {
  /** ARM (default: the Azure adapter's endpoint). */
  azureArm?: string;
  /** DigitalOcean's API (`https://api.digitalocean.com`) and serverless inference (`https://inference.do-ai.run`). */
  doApi?: string;
  doInference?: string;
  /** Cloudflare's API v4 base (`https://api.cloudflare.com/client/v4`). */
  cloudflareApi?: string;
}

export class CloudModelCatalogue {
  private readonly listers = new Map<Provider, CloudModelLister>();
  endpoints: ModelCatalogueEndpoints = {};

  constructor(private readonly s: () => Services) {}

  /** Registers (or replaces) the lister for a provider. */
  register(provider: Provider, lister: CloudModelLister): void {
    this.listers.set(provider, lister);
  }

  has(provider: Provider): boolean {
    return this.listers.has(provider);
  }

  /** What the account offers. Refused for a pending or disabled account, and for a provider with no lister. */
  async listModels(account: CloudAccount, opts: { signal?: AbortSignal } = {}): Promise<CloudModelListing[]> {
    if (account.state === 'pending') throw conflict(`${account.name} waits for a second cloud admin's approval; it cannot be used yet.`);
    if (account.state === 'disabled') throw conflict(`${account.name} is disabled.`);
    const lister = this.listers.get(account.provider);
    if (!lister) throw new HttpProblem(409, 'Conflict', `This build lists no ${account.provider} models yet.`, { extensions: { reason: 'unsupported' } });
    return lister.listModels(account, opts);
  }

  /** The services, for listers registered from other modules. */
  get services(): Services {
    return this.s();
  }
}
