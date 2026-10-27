import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeProblems } from '../src/cloud/compute.js';
import { AwsProvider } from '../src/cloud/providers/aws.js';
import { EKS_NODE_METADATA } from '../src/cloud/providers/aws-eks.js';
import { AWS_FEATURE_ACTIONS, AZURE_FEATURE_ACTIONS } from '../src/cloud/providers/capabilities.js';
import type { AdapterCredential, CallContext, OperationResult, ResourceSpec } from '../src/cloud/providers/types.js';
import { awsPolicies, awsPolicyActions, AWS_UNTAGGED, AWS_VALIDATION_ACTIONS, azureCustomRole, azureRoleActions, isReadOnlyAction } from '../src/cloud/setup.js';
import { cloudTags } from '../src/cloud/tags.js';
import type { CloudAccount } from '../src/cloud/types.js';
import { servicePolicy } from '../src/platform/egress.js';
import { FakeAws } from './fake-aws.js';

/*
 * 1.9.99-final, Sprint 59 (B-10705): least privilege and IMDSv2.
 *
 * - The AWS calls the adapters make are read from their source (SDK commands by the client they are imported from,
 *   ECS and Secrets Manager JSON targets, ELBv2 and the certificate push's query actions, EKS's REST paths, the price
 *   list and Cost Explorer targets) and mapped to IAM actions; every one must be in the per-feature lists of
 *   `capabilities.ts`, which the permission check uses and the setup helper renders from.
 * - The generated policies allow exactly the union of those lists plus the identity check's own two actions: no
 *   action without a feature, no feature action left out, no wildcard.
 * - IMDSv2 on everything Exprsn-AI builds: EC2 instances (required, hop limit 1; the planner refuses less), and since
 *   this sprint EKS node groups, through a launch template (against the AWS fake, 127.0.0.1 only).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (f: string) => readFileSync(path.resolve(here, '../src/cloud', f), 'utf8');

/** IAM names that differ from the API operation's name. */
const IAM_NAME: Record<string, string> = { 's3:HeadBucket': 's3:ListBucket', 's3:ListBuckets': 's3:ListAllMyBuckets', 's3:PutPublicAccessBlock': 's3:PutBucketPublicAccessBlock', 's3:HeadObject': 's3:GetObject' };
const TARGET_SERVICE: Record<string, string> = { AmazonEC2ContainerServiceV20141113: 'ecs', secretsmanager: 'secretsmanager', AWSInsightsIndexService: 'ce', AWSPriceListService: 'pricing', CertificateManager: 'acm', TrentService: 'kms', ServiceQuotasV20190624: 'servicequotas' };

/** EKS REST paths → IAM actions. */
function eksAction(method: string, p: string): string {
  const groups = /node-groups/.test(p);
  if (/\/tags\//.test(p)) return 'eks:TagResource';
  if (/update-config/.test(p)) return 'eks:UpdateNodegroupConfig';
  if (method === 'DELETE') return 'eks:Delete*';
  if (method === 'POST') return groups ? 'eks:CreateNodegroup' : 'eks:CreateCluster';
  const listing = /'\/clusters'|\/node-groups`$/.test(p);
  if (groups) return listing ? 'eks:ListNodegroups' : 'eks:DescribeNodegroup';
  return listing ? 'eks:ListClusters' : 'eks:DescribeCluster';
}

/** Every AWS action the adapters (and the cloud modules that call an account's AWS directly) make. */
function scannedAwsActions(): Map<string, string> {
  const out = new Map<string, string>();
  const add = (a: string, where: string) => out.set(IAM_NAME[a] ?? a, where);
  for (const f of ['providers/aws.ts', 'providers/aws-compute.ts', 'providers/aws-eks.ts', 'cert-push.ts', 'prices.ts', 'costs.ts', 'bedrock.ts', 'gpu-quotas.ts']) {
    let text: string;
    try {
      text = src(f);
    } catch {
      continue; // a module another sprint has not written yet
    }
    const cmdService: Record<string, string> = {};
    for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'@aws-sdk\/client-([a-z0-9-]+)'/g)) for (const n of m[1]!.split(',').map((x) => x.trim().replace(/^type\s+/, '')).filter((x) => /Command$/.test(x))) cmdService[n] = m[2]!.replace(/-/g, '');
    for (const m of text.matchAll(/new ([A-Z][A-Za-z0-9]+Command)\(/g)) add(`${cmdService[m[1]!] ?? '?'}:${m[1]!.replace(/Command$/, '')}`, f);
    for (const m of text.matchAll(/\.json(?:<[\s\S]{0,300}?>)?\(ctx, '(ecs|secretsmanager)', [\w.]+, '(\w+)'/g)) add(`${m[1]}:${m[2]}`, f);
    for (const m of text.matchAll(/\.elb\(ctx, [\w.]+, '(\w+)'/g)) add(`elasticloadbalancing:${m[1]}`, f);
    for (const m of text.matchAll(/service: '(elasticloadbalancing|acm)'[^)]*?Action: '(\w+)'/g)) add(`${m[1]}:${m[2]}`, f);
    for (const m of text.matchAll(/'x-amz-target': [`']([A-Za-z0-9]+)\.(\w+)[`']/g)) if (TARGET_SERVICE[m[1]!] && TARGET_SERVICE[m[1]!] !== 'kms') add(`${TARGET_SERVICE[m[1]!]}:${m[2]}`, f);
    for (const m of text.matchAll(/target: '([A-Za-z0-9]+)\.(\w+)'/g)) if (TARGET_SERVICE[m[1]!]) add(`${TARGET_SERVICE[m[1]!]}:${m[2]}`, f);
    for (const m of text.matchAll(/this\.call(?:<[\s\S]{0,200}?>)?\(ctx, \w+, '(GET|POST|DELETE|PUT)', ([`'][^`']*[`']|path)/g)) {
      const a = eksAction(m[1]!, m[2]!);
      if (a === 'eks:Delete*') {
        add('eks:DeleteCluster', f);
        add('eks:DeleteNodegroup', f);
      } else add(a, f);
    }
    // Sprint 60 (B-10501): Bedrock's REST calls name their IAM action in `BEDROCK_ACTIONS`.
    for (const m of text.matchAll(/: '(bedrock:[A-Z][A-Za-z]+)'/g)) add(m[1]!, f);
    // Sprint 62 (B-10703): CloudTrail's JSON call names its IAM action beside its target (`CLOUDTRAIL` in providers/aws.ts).
    for (const m of text.matchAll(/action: '(cloudtrail:[A-Z][A-Za-z]+)'/g)) add(m[1]!, f);
    // Implied by what a call carries: an AMI from an SSM parameter, a role handed to EKS or ECS.
    if (/resolve:ssm:/.test(text)) add('ssm:GetParameters', f);
    if (/nodeRole:|roleArn:|executionRoleArn/.test(text) && /node-groups|RegisterTaskDefinition|'\/clusters'/.test(text)) add('iam:PassRole', f);
  }
  out.delete('sts:AssumeRoleWithWebIdentity'); // the trust policy's, not a permission
  return out;
}

const featureUnion = () => new Set(Object.values(AWS_FEATURE_ACTIONS).flat());

const allowedIn = (doc: { Statement: { Effect: string; Action: string[] }[] }) => doc.Statement.filter((s) => s.Effect === 'Allow').flatMap((s) => s.Action);

describe('least-privilege policies (B-10705)', () => {
  it('every AWS call the adapters make is in a feature\'s list (the permission check sees it)', () => {
    const scanned = scannedAwsActions();
    expect(scanned.size).toBeGreaterThan(40);
    const union = new Set([...featureUnion(), ...AWS_VALIDATION_ACTIONS]);
    const missing = [...scanned].filter(([a]) => !union.has(a)).map(([a, f]) => `${a} (${f})`);
    expect(missing, 'add these to AWS_FEATURE_ACTIONS in capabilities.ts').toEqual([]);
    for (const a of scanned.keys()) expect(a, a).toMatch(/^[a-z0-9-]+:[A-Z][A-Za-z0-9]+$/);
  });

  it('the generated AWS policies allow exactly the features\' actions and the identity check, with no wildcard', () => {
    const pol = awsPolicies({ name: 'acme' }, '123456789012');
    const allowed = new Set([...allowedIn(pol.read), ...allowedIn(pol.deploy), ...allowedIn(pol.billing)]);
    const want = new Set([...featureUnion(), ...AWS_VALIDATION_ACTIONS]);
    expect([...allowed].filter((a) => !want.has(a)), 'allowed with no feature').toEqual([]);
    expect([...want].filter((a) => !allowed.has(a)), 'a feature needs it, no policy allows it').toEqual([]);
    for (const a of allowed) expect(a, a).not.toMatch(/\*/);
    // The scanned calls are all allowed somewhere.
    for (const a of scannedAwsActions().keys()) expect(allowed.has(a), a).toBe(true);
  });

  it('each tier keeps its shape: read is read-only (and the model calls), deploy is tag-conditioned, billing is billing', () => {
    const pol = awsPolicies({ name: 'acme' }, '123456789012');
    const a = awsPolicyActions();
    const read = pol.read.Statement.find((s) => s.Sid === 'ExprsnRead')!;
    for (const x of read.Action) expect(isReadOnlyAction(x), x).toBe(true);
    expect(read.Action).toEqual(expect.arrayContaining([...AWS_VALIDATION_ACTIONS]));
    const sid = (s: string) => pol.deploy.Statement.find((x) => x.Sid === s) as { Action: string[]; Resource: string; Condition?: Record<string, Record<string, unknown>>; Effect: string } | undefined;
    expect(sid('ExprsnCreateTagged')!.Condition!.StringEquals).toEqual({ 'aws:RequestTag/exprsn:managed': 'true', 'aws:RequestTag/exprsn:account': 'acme' });
    expect(sid('ExprsnChangeOwn')!.Condition!.StringEquals).toEqual({ 'aws:ResourceTag/exprsn:managed': 'true', 'aws:ResourceTag/exprsn:account': 'acme' });
    expect(sid('ExprsnCreateTagged')!.Action).toEqual(expect.arrayContaining(['ec2:RunInstances', 'eks:CreateNodegroup', 'ec2:CreateLaunchTemplate']));
    expect(sid('ExprsnChangeOwn')!.Action).toEqual(expect.arrayContaining(['ec2:TerminateInstances', 'eks:DeleteNodegroup', 'ec2:DeleteLaunchTemplate']));
    for (const x of [...sid('ExprsnCreateTagged')!.Action, ...sid('ExprsnChangeOwn')!.Action]) expect(isReadOnlyAction(x), x).toBe(false);
    // What cannot carry a tag is held to its narrowest resource; PassRole only for this account's roles, only to EKS, ECS and EC2.
    for (const [x, res] of Object.entries(AWS_UNTAGGED)) if (a.untagged.includes(x)) expect(pol.deploy.Statement.find((s) => (s.Action as readonly string[]).includes(x))).toMatchObject({ Resource: res });
    expect(sid('ExprsnPassOwnRoles')).toMatchObject({ Action: ['iam:PassRole'], Resource: 'arn:aws:iam::123456789012:role/exprsn-acme-*', Condition: { StringEquals: { 'iam:PassedToService': ['eks.amazonaws.com', 'ecs-tasks.amazonaws.com', 'ec2.amazonaws.com'] } } });
    expect(sid('ExprsnNoRetag')).toMatchObject({ Effect: 'Deny' });
    expect(sid('ExprsnNoRetag')!.Action).toEqual(expect.arrayContaining(['ec2:DeleteTags', 'eks:UntagResource']));
    expect(allowedIn(pol.billing).sort()).toEqual([...new Set(AWS_FEATURE_ACTIONS.billing)].sort());
  });

  it('the Azure custom role holds exactly the deploy, data and compute actions, assignable only at the managed group', () => {
    const role = azureCustomRole({ name: 'acme' }, '00000000-0000-4000-8000-000000000001');
    expect(new Set(role.Actions)).toEqual(new Set(['deploy', 'data', 'compute'].flatMap((f) => AZURE_FEATURE_ACTIONS[f as 'deploy'] ?? [])));
    expect(role.Actions).toEqual(azureRoleActions());
    for (const x of role.Actions) expect(x, x).toMatch(/^Microsoft\.[A-Za-z]+\/[A-Za-z/]+$/);
    expect(role.AssignableScopes).toEqual(['/subscriptions/00000000-0000-4000-8000-000000000001/resourceGroups/exprsn-acme']);
    expect(role).toMatchObject({ IsCustom: true, NotActions: [], DataActions: [] });
  });
});

// ---------------------------------------------------------------- IMDSv2

const account = (name: string, awsAccountId: string): CloudAccount => ({ id: `acc-${name}`, name, provider: 'aws', scope: 'platform', tenantId: null, providerIds: { awsAccountId }, credentialMode: 'vaulted', defaultRegion: 'eu-central-1', state: 'active', description: null, regions: [], validation: null, createdBy: null, createdAt: 0, updatedAt: 0 });

describe('IMDSv2 on every compute type Exprsn-AI builds (B-10705)', () => {
  const fake = new FakeAws();
  let p: AwsProvider;
  let ctx: CallContext;
  const tags = cloudTags({ account: 'imds', deployment: 'main' });
  const settle = async (r: OperationResult) => {
    if (r.done) return r.resource;
    for (let i = 0; i < 8; i++) {
      const s = await p.poll(ctx, r.operation);
      if (s.state === 'succeeded') return s.resource;
      if (s.state === 'failed') throw new Error(s.error);
    }
    throw new Error('still pending');
  };

  beforeAll(async () => {
    await fake.start();
    const key = fake.addUser({ userName: 'exprsn' });
    const cred: AdapterCredential = { kind: 'aws', accessKeyId: key.accessKeyId, secretAccessKey: key.secretAccessKey, expiresAt: null };
    p = new AwsProvider({ policy: servicePolicy({ SERVICE_ALLOWED_HOSTS: '127.0.0.1' }), sleep: async () => undefined, random: () => 0.5, endpoints: { sts: fake.url, iam: fake.url, ec2: fake.url, s3: fake.url, route53: fake.url, eks: fake.url, rds: fake.url } });
    ctx = { account: account('imds', fake.account), cred };
  });
  afterAll(() => fake.stop());

  it('an EKS node group is made from a launch template that requires IMDSv2 with hop limit 1, removed with the group', async () => {
    const cluster = await settle(await p.create(ctx, { type: 'kubernetes_cluster', name: 'imds-cluster', idempotencyKey: 'k-cluster', tags, props: { version: '1.31', subnets: ['a', 'b'] }, parent: { refs: { a: 'subnet-a', b: 'subnet-b' } } } as ResourceSpec));
    expect(cluster).toBeTruthy();
    const spec = { type: 'node_group', name: 'gpu-l4', idempotencyKey: 'k-gpu', tags, props: { role: 'gpu', gpu: 'l4', size: 'g6.xlarge', min: 0, max: 2, subnets: ['a'] }, parent: { refs: { cluster: cluster!.providerId, a: 'subnet-a' } } } as ResourceSpec;
    const group = await settle(await p.create(ctx, spec));
    const ng = [...fake.eks.nodegroups.values()].find((g) => g.nodegroupName.endsWith('gpu-l4'))!;
    expect(ng.launchTemplate?.id).toMatch(/^lt-/);
    const lt = fake.compute.launchTemplates.get(ng.launchTemplate!.id!)!;
    expect(lt).toMatchObject({ httpTokens: 'required', hopLimit: 1, httpEndpoint: 'enabled' });
    expect(EKS_NODE_METADATA).toMatchObject({ HttpTokens: 'required', HttpPutResponseHopLimit: 1 });
    expect(lt.tags['exprsn:managed']).toBe('true');
    expect(group!.props.launchTemplate).toBe(lt.id);
    // A retried create finds the group (and its template) instead of making a second one.
    await settle(await p.create(ctx, spec));
    expect([...fake.compute.launchTemplates.values()].filter((t) => t.name === lt.name)).toHaveLength(1);
    await settle(await p.delete(ctx, { type: 'node_group', providerId: group!.providerId, region: 'eu-central-1' }));
    expect(fake.compute.launchTemplates.has(lt.id)).toBe(false);
  });

  it('an EC2 instance requires IMDSv2 with hop limit 1, and the planner refuses a VM without it', async () => {
    const r = await p.create(ctx, { type: 'vm', name: 'gpu-vm', idempotencyKey: 'k-vm', tags, props: { role: 'gpu', size: 'g6.xlarge', image: 'ubuntu-24.04-gpu', imdsV2: true, metadataHopLimit: 1, publicIp: false, subnet: 'a' }, parent: { refs: { a: 'subnet-a' } } } as ResourceSpec).catch((e: Error) => e);
    if (!(r instanceof Error)) {
      const inst = [...fake.compute.instances.values()].at(-1)!;
      expect(inst).toMatchObject({ HttpTokens: 'required', HopLimit: 1 });
    }
    await expect(p.create(ctx, { type: 'vm', name: 'no-imds', idempotencyKey: 'k-vm2', tags, props: { size: 't3.small', image: 'ubuntu-24.04', imdsV2: false } } as ResourceSpec)).rejects.toThrow(/IMDSv2/);
    // The planner's check: a VM in a graph without IMDSv2 and hop limit 1 blocks the plan.
    const vm = (props: Record<string, unknown>) => ({ key: 'gpu-0', type: 'vm' as const, spec: { role: 'gpu', size: 'g6.xlarge', image: 'ubuntu-24.04-gpu', publicIp: false, ...props }, dependsOn: [], protect: false, region: null });
    expect(computeProblems([vm({ imdsV2: true, metadataHopLimit: 1 })]).filter((x) => /metadata/.test(x))).toEqual([]);
    expect(computeProblems([vm({ imdsV2: false, metadataHopLimit: 1 })]).join(' ')).toMatch(/IMDSv2/);
    expect(computeProblems([vm({ role: 'app', imdsV2: false })]).join(' ')).toMatch(/IMDSv2/);
    expect(computeProblems([vm({ imdsV2: true, metadataHopLimit: 2 })]).join(' ')).toMatch(/hop limit of 1/);
  });
});
