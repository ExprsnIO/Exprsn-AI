import type { CloudFeature } from '../types.js';
import { ALL_OPS, capabilityTable, type CapabilityTable, type ResourceType } from './types.js';

/*
 * 1.9.99-final, Sprint 56 (B-10101): what each adapter drives, per resource type and operation, and the permissions
 * each feature needs per provider (B-10007). Plain data, kept apart from the adapters so the planner, the console and
 * the registry can read it without loading an SDK.
 */

// ---------- aws ----------

export const AWS_CAPABILITIES: CapabilityTable = capabilityTable(
  {
    network: { support: 'built', native: 'EC2 VPC', operations: ALL_OPS, idempotency: 'lookup_by_tag', tagging: 'native', lro: 'describe until available' },
    subnet: { support: 'built', native: 'EC2 subnet', operations: ALL_OPS, idempotency: 'lookup_by_tag', tagging: 'native', lro: 'describe until available' },
    firewall: { support: 'built', native: 'EC2 security group', operations: ALL_OPS, idempotency: 'lookup_by_tag', tagging: 'native', note: 'Ingress rules are reconciled on create, adopt and update.' },
    bucket: { support: 'built', native: 'S3 bucket', operations: ALL_OPS, idempotency: 'lookup_by_name', tagging: 'native', note: 'Public access is blocked on create.' },
    dns_record: { support: 'built', native: 'Route 53 record set', operations: ALL_OPS, idempotency: 'natural', tagging: 'none', lro: 'GetChange until INSYNC', note: 'Route 53 records take no tags; the journal holds them.' },
    kubernetes_cluster: { support: 'built', native: 'EKS cluster', operations: ALL_OPS, idempotency: 'client_token', tagging: 'native', lro: 'DescribeCluster until ACTIVE', note: 'Sprint 58 (B-10203): access entries (API mode), the creator as cluster admin; tokens from a presigned STS GetCallerIdentity.' },
    node_group: { support: 'built', native: 'EKS managed node group', operations: ALL_OPS, idempotency: 'client_token', tagging: 'native', lro: 'DescribeNodegroup until ACTIVE', note: 'Sprint 58 (B-10203); GPU pools are node groups too (B-10401).' },
    vm: { support: 'built', native: 'EC2 instance', operations: ALL_OPS, idempotency: 'client_token', tagging: 'native', lro: 'describe until running', note: 'IMDSv2 required with hop limit 1; cloud-init runs the installer from the signed release (B-10204).' },
    container_service: { support: 'built', native: 'ECS service on Fargate', operations: ALL_OPS, idempotency: 'client_token', tagging: 'native', lro: 'migration task, then the service until its deployment settles', note: 'Cluster, task definition, the service’s own ALB, secrets in Secrets Manager; migrations as a one-off RunTask (B-10205).' },
    database: { support: 'built', native: 'RDS instance or Aurora cluster (PostgreSQL, MySQL)', operations: ALL_OPS, idempotency: 'lookup_by_name', tagging: 'native', lro: 'DescribeDBInstances / DescribeDBClusters until available', note: 'Sprint 59 (B-10301, B-10303, B-10307): private only (a DB subnet group in the data subnets, the data security group, not publicly accessible), a parameter group per database, deletion protection on, manual snapshots, restore to a new instance.' },
    cache: { support: 'built', native: 'ElastiCache replication group (Valkey or Redis OSS)', operations: ALL_OPS, idempotency: 'lookup_by_name', tagging: 'native', lro: 'describe until available', note: 'Sprint 59 (B-10305): cluster mode off, TLS with an AUTH token from the vault, a parameter group with maxmemory-policy noeviction. MemoryDB is described and listed only (always cluster mode, refused as REDIS_URL).' },
    load_balancer: { support: 'built', native: 'Elastic Load Balancing v2 (ALB)', operations: ALL_OPS, idempotency: 'natural', tagging: 'none', note: 'Sprint 58 (B-10203): the ALB the AWS Load Balancer Controller makes from a Kubernetes release\'s ingress (managedBy: cluster); a standalone ALB is B-10204/B-10205.' },
    secret: { support: 'not_yet', native: 'Secrets Manager secret', operations: [], idempotency: 'client_token', note: 'Sprint 58 (B-10208).' }
  },
  () => ({ support: 'unsupported', native: '-', operations: [], note: 'AWS has no Cloudflare-style tunnel; the front door is Cloudflare’s (B-109).' })
);

/** The IAM actions each feature needs (B-10007), checked with SimulatePrincipalPolicy. */
export const AWS_FEATURE_ACTIONS: Partial<Record<CloudFeature, string[]>> = {
  deploy: ['ec2:CreateVpc', 'ec2:DeleteVpc', 'ec2:DescribeVpcs', 'ec2:CreateSubnet', 'ec2:DeleteSubnet', 'ec2:CreateSecurityGroup', 'ec2:DeleteSecurityGroup', 'ec2:AuthorizeSecurityGroupIngress', 'ec2:RevokeSecurityGroupIngress', 'ec2:CreateTags', 's3:CreateBucket', 's3:DeleteBucket', 's3:PutBucketTagging', 's3:PutBucketPublicAccessBlock', 'route53:ChangeResourceRecordSets', 'route53:ListResourceRecordSets', 'route53:GetChange', 'eks:CreateCluster', 'eks:DescribeCluster', 'eks:DeleteCluster', 'eks:TagResource', 'eks:CreateNodegroup', 'eks:DescribeNodegroup', 'eks:DeleteNodegroup', 'eks:UpdateNodegroupConfig', 'iam:PassRole', 'elasticloadbalancing:CreateLoadBalancer', 'ec2:RunInstances', 'ec2:TerminateInstances', 'ec2:DescribeInstances', 'ec2:ModifyInstanceMetadataOptions', 'ec2:GetConsoleOutput', 'ssm:GetParameters', 'ecs:CreateCluster', 'ecs:DeleteCluster', 'ecs:RegisterTaskDefinition', 'ecs:DescribeTaskDefinition', 'ecs:RunTask', 'ecs:DescribeTasks', 'ecs:CreateService', 'ecs:UpdateService', 'ecs:DescribeServices', 'ecs:DeleteService', 'ecs:TagResource', 'elasticloadbalancing:CreateTargetGroup', 'elasticloadbalancing:CreateListener', 'elasticloadbalancing:DescribeLoadBalancers', 'elasticloadbalancing:DeleteLoadBalancer', 'elasticloadbalancing:DeleteTargetGroup', 'secretsmanager:CreateSecret', 'secretsmanager:PutSecretValue', 'secretsmanager:DeleteSecret', 'secretsmanager:TagResource',
    // 1.9.99-final, Sprint 59 (B-10705): what the adapters also call (refresh, find, the cluster's certificate push), so the
    // generated policy and this check list every action the deploy worker uses (`cloud-least-privilege.test.ts`).
    'ec2:DescribeSubnets', 'ec2:DescribeSecurityGroups', 'ec2:CreateLaunchTemplate', 'ec2:DescribeLaunchTemplates', 'ec2:DeleteLaunchTemplate', 'eks:ListClusters', 'eks:ListNodegroups', 'ecs:ListClusters', 'elasticloadbalancing:DescribeTargetGroups', 'elasticloadbalancing:DescribeListeners', 'elasticloadbalancing:ModifyListener', 'acm:ImportCertificate', 'route53:ListHostedZones', 's3:ListAllMyBuckets', 's3:ListBucket', 's3:GetBucketTagging', 'secretsmanager:ListSecrets',
    // Sprint 62 (B-10703): the change trail on drift findings ("changed by"), read only for resources with open findings.
    'cloudtrail:LookupEvents'],
  data: ['rds:CreateDBInstance', 'rds:DescribeDBInstances', 'rds:DeleteDBInstance', 'rds:CreateDBSnapshot', 'rds:ModifyDBInstance', 'rds:CreateDBCluster', 'rds:DescribeDBClusters', 'rds:ModifyDBCluster', 'rds:DeleteDBCluster', 'rds:CreateDBClusterSnapshot', 'rds:DescribeDBClusterSnapshots', 'rds:DeleteDBClusterSnapshot', 'rds:RestoreDBClusterFromSnapshot', 'rds:DescribeDBSnapshots', 'rds:DeleteDBSnapshot', 'rds:RestoreDBInstanceFromDBSnapshot', 'rds:CreateDBSubnetGroup', 'rds:CreateDBParameterGroup', 'rds:ModifyDBParameterGroup', 'rds:DescribeDBParameters', 'rds:CreateDBClusterParameterGroup', 'rds:ModifyDBClusterParameterGroup', 'rds:DescribeDBClusterParameters', 'rds:AddTagsToResource', 'elasticache:CreateCacheCluster', 'elasticache:DescribeCacheClusters', 'elasticache:DeleteCacheCluster', 'elasticache:CreateReplicationGroup', 'elasticache:DescribeReplicationGroups', 'elasticache:ModifyReplicationGroup', 'elasticache:DeleteReplicationGroup', 'elasticache:CreateCacheParameterGroup', 'elasticache:ModifyCacheParameterGroup', 'elasticache:DescribeCacheParameters', 'elasticache:CreateCacheSubnetGroup', 'elasticache:ModifyCacheSubnetGroup', 'elasticache:AddTagsToResource', 'elasticache:ListTagsForResource', 'memorydb:DescribeClusters'],
  compute: ['ec2:RunInstances', 'ec2:TerminateInstances', 'ec2:DescribeInstances', 'eks:CreateNodegroup', 'eks:UpdateNodegroupConfig', 'eks:DescribeNodegroup', 'ec2:CreateLaunchTemplate', 'ec2:DescribeLaunchTemplates', 'ec2:DeleteLaunchTemplate', /* Sprint 60 (B-10405): the GPU quotas at plan time */ 'servicequotas:GetServiceQuota'],
  // 1.9.99-final, Sprint 60 (B-10501, B-10504): what `cloud/bedrock.ts` calls (Converse and InvokeModel are InvokeModel; ConverseStream is InvokeModelWithResponseStream).
  // Sprint 61 (B-10506): the Bedrock Guardrail layer: ApplyGuardrail (also what Converse with guardrailConfig needs) and GetGuardrail (the setting is checked).
  models: ['bedrock:ListFoundationModels', 'bedrock:ListInferenceProfiles', 'bedrock:GetFoundationModelAvailability', 'bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream', 'bedrock:ApplyGuardrail', 'bedrock:GetGuardrail'],
  // Sprint 61 (B-10505): pricing:GetProducts also prices Bedrock models (`cloud/model-prices.ts`, service code AmazonBedrock).
  billing: ['ce:GetCostAndUsage', 'pricing:GetProducts']
};

// ---------- azure ----------

export const AZURE_CAPABILITIES: CapabilityTable = capabilityTable(
  {
    network: { support: 'built', native: 'Virtual network', operations: ALL_OPS, idempotency: 'put_by_name', tagging: 'native', lro: 'Azure-AsyncOperation' },
    subnet: { support: 'built', native: 'Virtual network subnet', operations: ALL_OPS, idempotency: 'put_by_name', tagging: 'none', lro: 'Azure-AsyncOperation', note: 'Subnets take no tags; their network carries them.' },
    firewall: { support: 'built', native: 'Network security group', operations: ALL_OPS, idempotency: 'put_by_name', tagging: 'native', lro: 'Azure-AsyncOperation' },
    bucket: { support: 'built', native: 'Storage account (Blob)', operations: ALL_OPS, idempotency: 'put_by_name', tagging: 'native', lro: 'Location', note: 'Public blob access off, TLS 1.2 minimum, HTTPS only.' },
    dns_record: { support: 'built', native: 'Azure DNS record set', operations: ALL_OPS, idempotency: 'put_by_name', tagging: 'metadata' },
    kubernetes_cluster: { support: 'built', native: 'AKS cluster', operations: ALL_OPS, idempotency: 'put_by_name', tagging: 'native', lro: 'Azure-AsyncOperation', note: 'Sprint 58 (B-10203): AKS-managed Entra ID with local accounts off, Azure RBAC, application routing for ingress.' },
    node_group: { support: 'built', native: 'AKS agent pool', operations: ALL_OPS, idempotency: 'put_by_name', tagging: 'native', lro: 'Azure-AsyncOperation', note: 'Sprint 58 (B-10203); GPU pools in Sprint 60 (B-10401).' },
    vm: { support: 'built', native: 'Virtual machine', operations: ALL_OPS, idempotency: 'put_by_name', tagging: 'native', lro: 'Azure-AsyncOperation', note: 'Trusted Launch with a vTPM, no public address; cloud-init runs the installer from the signed release (B-10204).' },
    container_service: { support: 'built', native: 'Container Apps', operations: ALL_OPS, idempotency: 'put_by_name', tagging: 'native', lro: 'environment, migration job, then the app’s revision', note: 'Managed environment, a manual migration job, the app in single revision mode with secrets mounted as files (B-10205).' },
    database: { support: 'built', native: 'Database for PostgreSQL / MySQL flexible server', operations: ALL_OPS, idempotency: 'put_by_name', tagging: 'native', lro: 'Azure-AsyncOperation', note: 'Sprint 59 (B-10301, B-10303, B-10307): public network access off and a private endpoint in the data subnet, server parameters (azure.extensions for the extension allow-list), a CanNotDelete lock for deletion protection, on-demand backups, a retained copy as the final snapshot.' },
    cache: { support: 'built', native: 'Azure Cache for Redis or Azure Managed Redis', operations: ALL_OPS, idempotency: 'put_by_name', tagging: 'native', lro: 'describe until Succeeded', note: 'Sprint 59 (B-10305): TLS only, public network access off with a private endpoint, maxmemory-policy noeviction; Azure Managed Redis with the NoCluster policy and NoEviction. Keys read back with listKeys.' },
    load_balancer: { support: 'built', native: 'Load balancer (AKS application routing)', operations: ALL_OPS, idempotency: 'natural', tagging: 'none', note: 'Sprint 58 (B-10203): the load balancer in front of AKS application routing\'s ingress controller (managedBy: cluster); a standalone one is B-10204/B-10205.' },
    secret: { support: 'not_yet', native: 'Key Vault secret', operations: [], idempotency: 'put_by_name', note: 'Sprint 58 (B-10208).' }
  },
  () => ({ support: 'unsupported', native: '-', operations: [], note: 'Azure has no Cloudflare-style tunnel; the front door is Cloudflare’s (B-109).' })
);

/** The ARM actions each feature needs (B-10007), compared with `Microsoft.Authorization/permissions`. */
export const AZURE_FEATURE_ACTIONS: Partial<Record<CloudFeature, string[]>> = {
  deploy: ['Microsoft.Resources/subscriptions/resourceGroups/write', 'Microsoft.Resources/subscriptions/resourceGroups/read', 'Microsoft.Network/virtualNetworks/write', 'Microsoft.Network/virtualNetworks/delete', 'Microsoft.Network/virtualNetworks/subnets/write', 'Microsoft.Network/networkSecurityGroups/write', 'Microsoft.Network/networkSecurityGroups/delete', 'Microsoft.Storage/storageAccounts/write', 'Microsoft.Storage/storageAccounts/delete', 'Microsoft.Network/dnsZones/A/write', 'Microsoft.Network/dnsZones/CNAME/write', 'Microsoft.ContainerService/managedClusters/write', 'Microsoft.ContainerService/managedClusters/read', 'Microsoft.ContainerService/managedClusters/delete', 'Microsoft.ContainerService/managedClusters/agentPools/write', 'Microsoft.ContainerService/managedClusters/listClusterUserCredential/action', 'Microsoft.Network/networkInterfaces/write', 'Microsoft.Network/networkInterfaces/delete', 'Microsoft.Compute/virtualMachines/write', 'Microsoft.Compute/virtualMachines/read', 'Microsoft.Compute/virtualMachines/delete', 'Microsoft.Compute/virtualMachines/retrieveBootDiagnosticsData/action', 'Microsoft.App/managedEnvironments/write', 'Microsoft.App/managedEnvironments/delete', 'Microsoft.App/containerApps/write', 'Microsoft.App/containerApps/read', 'Microsoft.App/containerApps/delete', 'Microsoft.App/jobs/write', 'Microsoft.App/jobs/start/action', 'Microsoft.App/jobs/delete',
    // Sprint 62 (B-10703): the Activity Log the change trail reads (Reader on the subscription holds it too).
    'Microsoft.Insights/eventtypes/values/read'],
  data: ['Microsoft.DBforPostgreSQL/flexibleServers/write', 'Microsoft.DBforPostgreSQL/flexibleServers/read', 'Microsoft.DBforPostgreSQL/flexibleServers/delete', 'Microsoft.DBforPostgreSQL/flexibleServers/configurations/write', 'Microsoft.DBforPostgreSQL/flexibleServers/backups/write', 'Microsoft.DBforMySQL/flexibleServers/write', 'Microsoft.DBforMySQL/flexibleServers/read', 'Microsoft.DBforMySQL/flexibleServers/delete', 'Microsoft.DBforMySQL/flexibleServers/configurations/write', 'Microsoft.DBforMySQL/flexibleServers/backups/write', 'Microsoft.Network/privateEndpoints/delete', 'Microsoft.Authorization/locks/write', 'Microsoft.Authorization/locks/delete', 'Microsoft.Cache/redis/write', 'Microsoft.Cache/redis/read', 'Microsoft.Cache/redis/delete', 'Microsoft.Cache/redis/listKeys/action', 'Microsoft.Cache/redisEnterprise/write', 'Microsoft.Cache/redisEnterprise/read', 'Microsoft.Cache/redisEnterprise/delete', 'Microsoft.Cache/redisEnterprise/databases/write', 'Microsoft.Cache/redisEnterprise/databases/listKeys/action', 'Microsoft.Network/privateEndpoints/write'],
  compute: ['Microsoft.Compute/virtualMachines/write', 'Microsoft.Compute/virtualMachines/delete', 'Microsoft.ContainerService/managedClusters/agentPools/write', /* Sprint 60 (B-10405) */ 'Microsoft.Compute/locations/usages/read'],
  models: ['Microsoft.CognitiveServices/accounts/read', 'Microsoft.CognitiveServices/accounts/deployments/write'],
  billing: ['Microsoft.CostManagement/query/action', 'Microsoft.Consumption/usageDetails/read']
};

// ---------- digitalocean ----------

export const DO_CAPABILITIES: CapabilityTable = capabilityTable(
  {
    network: { support: 'built', native: 'VPC', operations: ALL_OPS, idempotency: 'lookup_by_name', tagging: 'description' },
    firewall: { support: 'built', native: 'Cloud firewall', operations: ALL_OPS, idempotency: 'lookup_by_name', tagging: 'name', lro: 'status until succeeded', note: 'Outbound traffic is allowed; inbound only by the rules given.' },
    dns_record: { support: 'built', native: 'Domain record', operations: ALL_OPS, idempotency: 'natural', tagging: 'none', note: 'One DigitalOcean record per value; DigitalOcean records take no tags.' },
    vm: { support: 'built', native: 'Droplet', operations: ALL_OPS, idempotency: 'lookup_by_tag', tagging: 'native', lro: 'create action' },
    bucket: { support: 'not_yet', native: 'Spaces bucket', operations: [], idempotency: 'lookup_by_name', note: 'Spaces speaks the S3 API with Spaces access keys, which the credential vault (B-10006) does not hold yet; Sprint 59 (B-103).' },
    kubernetes_cluster: { support: 'built', native: 'DOKS cluster', operations: ALL_OPS, idempotency: 'lookup_by_name', tagging: 'native', lro: 'status until running', note: 'Sprint 58 (B-10203): created with the app node pool (DOKS needs one); short-lived tokens from the credentials endpoint.' },
    node_group: { support: 'built', native: 'DOKS node pool', operations: ALL_OPS, idempotency: 'lookup_by_name', tagging: 'native', lro: 'nodes until running', note: 'Sprint 58 (B-10203); GPU pools in Sprint 60 (B-10401).' },
    container_service: { support: 'built', native: 'App Platform app', operations: ALL_OPS, idempotency: 'lookup_by_name', tagging: 'name', lro: 'the app’s deployment until active', note: 'One app spec with a PRE_DEPLOY migration job; secrets as SECRET values, the key-encryption key in OpenBao (B-10205).' },
    database: { support: 'built', native: 'Managed database cluster (PostgreSQL, MySQL)', operations: ALL_OPS, idempotency: 'lookup_by_name', tagging: 'native', lro: 'status until online', note: 'Sprint 59 (B-10301, B-10303, B-10307): in the data VPC, trusted sources limited to the data zone\'s sources (DigitalOcean keeps a public host name, refused by the firewall), daily backups with point-in-time recovery, a retained fork as the final snapshot; DigitalOcean has no deletion protection, so the adapter refuses a delete without the final snapshot.' },
    cache: { support: 'built', native: 'Managed Valkey cluster', operations: ALL_OPS, idempotency: 'lookup_by_name', tagging: 'native', lro: 'status until online', note: 'Sprint 59 (B-10305): in the deployment VPC, eviction policy noeviction, TLS; the generated password is read back from the cluster.' },
    load_balancer: { support: 'built', native: 'Load balancer (from a Kubernetes Service)', operations: ALL_OPS, idempotency: 'natural', tagging: 'none', note: 'Sprint 58 (B-10203): the load balancer DigitalOcean\'s cloud controller makes from the release\'s Service (managedBy: cluster); a standalone one is B-10204/B-10205.' }
  },
  (t) => ({ support: 'unsupported', native: '-', operations: [], note: t === 'subnet' ? 'DigitalOcean VPCs have no subnets.' : t === 'secret' ? 'DigitalOcean has no secrets store; secrets stay in the signer or OpenBao.' : 'DigitalOcean has no such service.' })
);

/** The token scopes each feature needs (B-10007). */
export const DO_FEATURE_SCOPES: Partial<Record<CloudFeature, string[]>> = {
  deploy: ['vpc:create', 'vpc:read', 'vpc:update', 'vpc:delete', 'firewall:create', 'firewall:read', 'firewall:update', 'firewall:delete', 'domain:create', 'domain:read', 'domain:update', 'domain:delete', 'kubernetes:create', 'kubernetes:read', 'load_balancer:create', 'tag:create', 'app:create', 'app:read', 'app:update', 'app:delete'],
  data: ['database:create', 'database:read', 'database:update', 'database:delete'],
  compute: ['droplet:create', 'droplet:read', 'droplet:delete', 'kubernetes:update', 'actions:read'],
  models: ['genai:read', 'genai:create'],
  billing: ['billing:read']
};

// ---------- cloudflare ----------

export const CF_CAPABILITIES: CapabilityTable = capabilityTable(
  {
    dns_record: { support: 'built', native: 'DNS record', operations: ALL_OPS, idempotency: 'natural', tagging: 'comment', note: 'One Cloudflare record per value.' },
    bucket: { support: 'built', native: 'R2 bucket', operations: ALL_OPS, idempotency: 'lookup_by_name', tagging: 'name' },
    tunnel: { support: 'built', native: 'Cloudflare Tunnel', operations: ALL_OPS, idempotency: 'lookup_by_name', tagging: 'name', note: 'The adapter never reads the token back; the front door (cloud/edge.ts, B-10902) reads it once into the vault for cloudflared.' },
    firewall: { support: 'not_yet', native: 'WAF custom rules', operations: [], note: 'The edge WAF and rate limits are the front door\'s (cloud/edge-waf.ts, B-10903), not a graph resource.' },
    // Sprint 61 (B-10905): the hybrid app tier (`providers/cloudflare-app.ts`).
    container_service: { support: 'built', native: 'Containers application', operations: ALL_OPS, idempotency: 'lookup_by_name', tagging: 'name', note: 'The image by digest as the Worker\'s Durable Object class; settings and secrets come from the Worker (B-10905).' },
    worker: { support: 'built', native: 'Worker script with static assets', operations: ALL_OPS, idempotency: 'lookup_by_name', tagging: 'name', note: 'Static assets uploaded from this build\'s console, plain settings as bindings, secrets as Worker secrets from the vault, Hyperdrive and the container as bindings, the custom domain (B-10905).' },
    hyperdrive: { support: 'built', native: 'Hyperdrive configuration', operations: ALL_OPS, idempotency: 'lookup_by_name', tagging: 'name', note: 'PostgreSQL directly or through the tunnel with an Access service token; the password goes from the vault to Cloudflare only (B-10905).' },
    database: { support: 'unsupported', native: 'D1', operations: [], note: 'D1 is never Exprsn-AI\'s own database, only a read-only data connection (B-10907); PostgreSQL is reached through Hyperdrive.' },
    load_balancer: { support: 'not_yet', native: 'Load Balancing', operations: [], note: 'Sprint 61 (B-109).' },
    secret: { support: 'not_yet', native: 'Workers secret', operations: [], note: 'Worker secrets are set with their Worker (the worker type, B-10905), not as resources of their own.' }
  },
  (t) => ({ support: 'unsupported', native: '-', operations: [], note: t === 'network' || t === 'subnet' ? 'Cloudflare has no private networks to create; the app tier reaches its data through a tunnel.' : 'Cloudflare runs the edge and the app tier only (B-109).' })
);

/** The permission groups each feature needs (B-10007, B-10009). */
export const CF_FEATURE_PERMISSIONS: Partial<Record<CloudFeature, string[]>> = {
  // Sprint 62 (B-10703): Account Settings Read for the audit logs the change trail reads on drift findings.
  frontdoor: ['Zone Read', 'DNS Write', 'Cloudflare Tunnel Write', 'SSL and Certificates Write', 'Zone WAF Write', 'Account Settings Read'],
  apptier: ['Workers Scripts Write', 'Containers Edit', 'Hyperdrive Write'],
  data: ['Workers R2 Storage Write', 'D1 Write'],
  models: ['Workers AI Read', 'AI Gateway Write'],
  billing: ['Billing Read']
};

// ---------- final snapshots (B-10107) ----------

/**
 * Why an adapter takes no final snapshot of a type before a protected resource is deleted, or null when it takes one.
 * Plain data, so the destroy can say so before anything is called.
 */
export function snapshotReason(provider: 'aws' | 'azure' | 'digitalocean' | 'cloudflare', type: ResourceType): string | null {
  if (provider === 'digitalocean' && type === 'vm') return null;
  // Sprint 59 (B-10307): RDS and Aurora manual snapshots, Azure and DigitalOcean retained copies.
  if (type === 'database') return provider === 'cloudflare' ? 'Cloudflare offers no database this build manages (D1 is only a read-only data connection, B-10907), so there is nothing to snapshot.' : null;
  if (type === 'bucket') return 'Object stores have no snapshot: copy the bucket’s data elsewhere, then remove its protection in the desired graph before destroying it.';
  if (type === 'vm') return 'This build takes final snapshots of DigitalOcean droplets only; an app VM on EC2 or Azure holds no data (the data tier does), so it is not protected and needs none.';
  return `A ${type.replace(/_/g, ' ')} has no snapshot; remove its protection in the desired graph before destroying it.`;
}
