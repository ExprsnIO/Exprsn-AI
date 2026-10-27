import type { Label } from '../authz/labels.js';
import type { CloudFeature, Provider } from './types.js';

/*
 * 1.9.99-final, Sprint 56: what Exprsn-AI offers per provider before any provider call.
 *
 * - `REGION_CATALOGUE` (B-10008, open decision 1): the regions offered first, each with its zone, its residency
 *   geography and the label ceiling it starts at. Every region starts at `internal`; raising one is a dual-control
 *   proposal, and `restricted` needs a platform admin's approval as well (open decision 4).
 * - `PERMISSION_CHECKLIST` (B-10009, B-10007): what each feature needs from the credential, per provider. The connect
 *   wizard shows it before the token exists; a provider adapter's `checkPermissions` reports against the same names.
 */

export interface CatalogueRegion {
  region: string;
  name: string;
  zone: string;
  geo: 'eu' | 'us' | 'ca' | 'global';
  /** The ceiling a region starts at when it is put on an account's allow-list. */
  ceiling: Label;
}

export const START_CEILING: Label = 'internal';

export const REGION_CATALOGUE: Record<Provider, readonly CatalogueRegion[]> = {
  aws: [
    { region: 'eu-central-1', name: 'Europe (Frankfurt)', zone: 'cloud-eu', geo: 'eu', ceiling: START_CEILING },
    { region: 'eu-west-1', name: 'Europe (Ireland)', zone: 'cloud-eu', geo: 'eu', ceiling: START_CEILING },
    { region: 'us-east-1', name: 'US East (N. Virginia)', zone: 'cloud-us', geo: 'us', ceiling: START_CEILING },
    { region: 'us-west-2', name: 'US West (Oregon)', zone: 'cloud-us', geo: 'us', ceiling: START_CEILING }
  ],
  azure: [
    { region: 'swedencentral', name: 'Sweden Central', zone: 'cloud-eu', geo: 'eu', ceiling: START_CEILING },
    { region: 'westeurope', name: 'West Europe', zone: 'cloud-eu', geo: 'eu', ceiling: START_CEILING },
    { region: 'eastus2', name: 'East US 2', zone: 'cloud-us', geo: 'us', ceiling: START_CEILING }
  ],
  digitalocean: [
    { region: 'ams3', name: 'Amsterdam 3', zone: 'cloud-eu', geo: 'eu', ceiling: START_CEILING },
    { region: 'fra1', name: 'Frankfurt 1', zone: 'cloud-eu', geo: 'eu', ceiling: START_CEILING },
    { region: 'nyc3', name: 'New York 3', zone: 'cloud-us', geo: 'us', ceiling: START_CEILING },
    { region: 'sfo3', name: 'San Francisco 3', zone: 'cloud-us', geo: 'us', ceiling: START_CEILING },
    { region: 'tor1', name: 'Toronto 1', zone: 'cloud-ca', geo: 'ca', ceiling: START_CEILING }
  ],
  cloudflare: [
    { region: 'global', name: 'Global edge', zone: 'edge', geo: 'global', ceiling: START_CEILING },
    { region: 'r2-eu', name: 'R2 jurisdiction EU', zone: 'edge-eu', geo: 'eu', ceiling: START_CEILING },
    { region: 'r2-fedramp', name: 'R2 jurisdiction FedRAMP', zone: 'edge-us', geo: 'us', ceiling: START_CEILING }
  ]
};

/** The residency geographies a tenant may name (the edge's `global` is never a residency). */
export const RESIDENCY_GEOS = ['eu', 'us', 'ca'] as const;
export type ResidencyGeo = (typeof RESIDENCY_GEOS)[number];

export const catalogueRegion = (provider: Provider, region: string): CatalogueRegion | undefined => REGION_CATALOGUE[provider].find((r) => r.region === region);

export interface ChecklistItem {
  /** The name a provider uses for it: an IAM action, an ARM permission, a DigitalOcean scope, a Cloudflare permission group. */
  permission: string;
  /** Where it applies, when the provider distinguishes (Cloudflare: Account or Zone). */
  level?: 'account' | 'zone';
  usedFor: string;
}

export const PERMISSION_CHECKLIST: Record<Provider, Partial<Record<CloudFeature, readonly ChecklistItem[]>>> = {
  aws: {
    deploy: [
      { permission: 'ec2:CreateVpc', usedFor: 'Network foundation' },
      { permission: 'ec2:RunInstances', usedFor: 'VM targets' },
      { permission: 'eks:CreateCluster', usedFor: 'Kubernetes targets' },
      { permission: 'ecs:CreateService', usedFor: 'Container platforms' },
      { permission: 'tag:GetResources', usedFor: 'Finding resources by their exprsn:* tags' }
    ],
    data: [
      { permission: 'rds:CreateDBInstance', usedFor: 'Managed PostgreSQL and MySQL' },
      { permission: 'elasticache:CreateReplicationGroup', usedFor: 'Managed caches' }
    ],
    compute: [
      { permission: 'eks:CreateNodegroup', usedFor: 'GPU node groups' },
      { permission: 'servicequotas:GetServiceQuota', usedFor: 'GPU quota checks' }
    ],
    models: [
      { permission: 'bedrock:ListFoundationModels', usedFor: 'Bedrock catalogue import' },
      { permission: 'bedrock:InvokeModelWithResponseStream', usedFor: 'Bedrock conversations' }
    ],
    billing: [
      { permission: 'ce:GetCostAndUsage', usedFor: 'Billing ingestion' },
      { permission: 'pricing:GetProducts', usedFor: 'Price catalogue' }
    ]
  },
  azure: {
    deploy: [
      { permission: 'Microsoft.Resources/subscriptions/resourceGroups/write', usedFor: 'Managed resource groups' },
      { permission: 'Microsoft.Network/virtualNetworks/write', usedFor: 'Network foundation' },
      { permission: 'Microsoft.ContainerService/managedClusters/write', usedFor: 'Kubernetes targets' }
    ],
    data: [
      { permission: 'Microsoft.DBforPostgreSQL/flexibleServers/write', usedFor: 'Managed PostgreSQL' },
      { permission: 'Microsoft.Cache/redis/write', usedFor: 'Managed caches' }
    ],
    compute: [{ permission: 'Microsoft.ContainerService/managedClusters/agentPools/write', usedFor: 'GPU node pools' }],
    models: [{ permission: 'Microsoft.CognitiveServices/accounts/deployments/read', usedFor: 'Azure AI Foundry deployments' }],
    billing: [{ permission: 'Microsoft.CostManagement/query/action', usedFor: 'Billing ingestion' }]
  },
  digitalocean: {
    deploy: [
      { permission: 'droplet:create', usedFor: 'Droplets' },
      { permission: 'kubernetes:create', usedFor: 'DOKS clusters' },
      { permission: 'app:create', usedFor: 'App Platform' },
      { permission: 'vpc:create', usedFor: 'Network foundation' },
      { permission: 'firewall:create', usedFor: 'Cloud firewalls' },
      { permission: 'domain:create', usedFor: 'DNS records' }
    ],
    data: [
      { permission: 'database:create', usedFor: 'Managed databases' },
      { permission: 'spaces:write', usedFor: 'Spaces object storage' }
    ],
    compute: [{ permission: 'kubernetes:update', usedFor: 'GPU node pools' }],
    models: [{ permission: 'genai:read', usedFor: 'GenAI serverless inference' }],
    billing: [{ permission: 'billing:read', usedFor: 'Balance and billing history' }]
  },
  cloudflare: {
    frontdoor: [
      { permission: 'Cloudflare Tunnel Edit', level: 'account', usedFor: 'Front door: Tunnel' },
      { permission: 'DNS Edit', level: 'zone', usedFor: 'DNS records' },
      { permission: 'Zone WAF Edit', level: 'zone', usedFor: 'WAF and rate-limit rules' },
      { permission: 'SSL and Certificates Edit', level: 'zone', usedFor: 'Edge TLS' },
      { permission: 'Access: Apps and Policies Edit', level: 'account', usedFor: 'Access before the admin console' }
    ],
    apptier: [
      { permission: 'Workers Scripts Edit', level: 'account', usedFor: 'App tier Worker' },
      { permission: 'Containers Edit', level: 'account', usedFor: 'App tier on Cloudflare Containers' },
      { permission: 'Hyperdrive Edit', level: 'account', usedFor: 'PostgreSQL through Hyperdrive' }
    ],
    data: [
      { permission: 'Workers R2 Storage Edit', level: 'account', usedFor: 'R2 object store' },
      { permission: 'D1 Read', level: 'account', usedFor: 'D1 read-only connection' }
    ],
    models: [
      { permission: 'Workers AI Read', level: 'account', usedFor: 'Workers AI model backend' },
      { permission: 'AI Gateway Edit', level: 'account', usedFor: 'AI Gateway proxy' }
    ],
    billing: [
      { permission: 'Account Analytics Read', level: 'account', usedFor: 'GraphQL Analytics, neurons' },
      { permission: 'Billing Read', level: 'account', usedFor: 'Billing ingestion' }
    ]
  }
};

/** The permission names a feature needs on a provider (empty when the provider offers nothing for it). */
export const requiredFor = (provider: Provider, feature: CloudFeature): string[] => (PERMISSION_CHECKLIST[provider][feature] ?? []).map((i) => i.permission);
