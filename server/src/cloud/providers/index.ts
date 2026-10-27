/*
 * 1.9.99-final, Sprint 56 (B-10101): the provider adapter layer. `registry.ts` is what the services use (light: it
 * loads an adapter on its first call); this index also exports the adapters themselves, for tests and tools.
 */

export * from './types.js';
export * from './capabilities.js';
export { ProviderRegistry, createProviderRegistry, providerFor, capabilityRows, supportOf, type ProviderEndpoints, type ProviderRegistryOptions } from './registry.js';
export { API_CLASSES, apiClassOf, CloudTransport, DEFAULT_CLASS_LIMITS, DEFAULT_HOURLY, DEFAULT_LIMITS, type ApiClass, type BreakerOptions, type BreakerState, type BucketLimit, type TransportMetrics, type TransportOptions, type TransportStats } from './transport.js';
export { smithyHandler, azureHttpClient } from './sdk-bridges.js';
export { AwsProvider, type AwsEndpoints } from './aws.js';
export { AzureProvider, type AzureEndpoints } from './azure.js';
export { DigitalOceanProvider, type DigitalOceanEndpoints } from './digitalocean.js';
export { CloudflareProvider, type CloudflareEndpoints } from './cloudflare.js';
