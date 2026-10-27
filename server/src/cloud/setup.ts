import { AWS_FEATURE_ACTIONS, AZURE_FEATURE_ACTIONS } from './providers/capabilities.js';
import { namePrefix, TAG_PREFIX } from './tags.js';
import { AWS_AUDIENCE, AZURE_AUDIENCE, DISCOVERY_NAME, JWKS_NAME, subjectOf } from './issuer.js';
import type { CloudAccount, CloudCredentialRef } from './types.js';

/*
 * 1.9.99-final, Sprint 56 (B-10003, B-10004): the setup helper. What the operator runs in the cloud so that it trusts
 * Exprsn-AI's federation issuer for one account, rendered as JSON documents and CLI text. Nothing here calls a cloud.
 *
 * AWS: the IAM OIDC provider for the issuer (client id `sts.amazonaws.com`), one role per purpose (or one for all)
 * whose trust policy is conditioned on `aud` and `sub` (`cloud-account:<id>`, so a role trusting another account's
 * subject refuses this one), and the read, deploy and billing permission policies, the deploy one conditioned on the
 * `exprsn:*` tags (creates must carry `exprsn:managed=true` and this account's `exprsn:account`; changes and deletes
 * reach only resources that carry them).
 *
 * Azure: the federated identity credential on the app registration or the user-assigned managed identity (issuer,
 * subject, audience `api://AzureADTokenExchange`), and the role assignments: Reader on the subscription, Contributor
 * on the managed resource groups, Cost Management Reader.
 *
 * Least privilege (1.9.99-final, Sprint 59, B-10705): the actions in these documents are derived from the per-feature
 * lists in `providers/capabilities.ts` (the same lists `validate` checks with SimulatePrincipalPolicy and the ARM
 * permissions call), never written here by hand, so a policy lists exactly what some feature uses and an adapter that
 * starts calling something new shows up in both places at once. `cloud-least-privilege.test.ts` scans the AWS
 * adapters' source for every API call and checks that each is in the feature lists, and that the generated
 * documents allow the union of those lists and nothing else. No `Describe*` or other wildcard is granted.
 *
 * - read: what the identity check needs (`AWS_VALIDATION_ACTIONS`) and every read-only action of every feature
 *   (refresh, drift, the orphan sweep, prices), plus the model calls (`models`, B-105).
 * - deploy: the read-only actions of deploy, data and compute (the deploy worker describes what it changes); creates
 *   only with `exprsn:managed=true` and this account's `exprsn:account` in the request's tags; changes and deletes
 *   only on resources carrying them; the few actions whose resources Exprsn-AI does not tag (`AWS_UNTAGGED`) on
 *   their narrowest resource; `iam:PassRole` only for this account's `exprsn-<account>-*` roles and only to EKS, ECS
 *   and EC2; and never removing an `exprsn:*` tag.
 * - billing: the billing feature's actions (Cost Explorer, the price list).
 * - Azure: a custom role (`exprsn-role.json`) with the deploy, data and compute actions, assignable only at the
 *   managed resource group, as the least-privilege alternative to Contributor there.
 */

export interface SetupStep {
  title: string;
  /** Commands to run, one per line (shell). */
  commands?: string[];
  /** A document to save as a file, with its name. */
  file?: { name: string; json: unknown };
  note?: string;
}

export interface SetupGuide {
  provider: CloudAccount['provider'];
  issuer: string;
  subject: string;
  audience: string | null;
  available: boolean;
  reason: string | null;
  steps: SetupStep[];
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const hostPath = (issuer: string) => issuer.replace(/^https?:\/\//, '');

/** The IAM actions the identity and permission check itself calls (B-10007), on the read credential. */
export const AWS_VALIDATION_ACTIONS = ['sts:GetCallerIdentity', 'iam:SimulatePrincipalPolicy'] as const;

/**
 * Actions whose resources Exprsn-AI does not tag, so no `exprsn:*` tag condition can scope them, each on its narrowest
 * resource: Route 53 record sets take no tags (the hosted zones are the operator's); a certificate pushed to a cluster's
 * load balancer is imported untagged and the listener belongs to the load balancer the cluster's controller made.
 */
export const AWS_UNTAGGED: Record<string, string> = {
  'route53:ChangeResourceRecordSets': 'arn:aws:route53:::hostedzone/*',
  'acm:ImportCertificate': 'arn:aws:acm:*:*:certificate/*',
  'elasticloadbalancing:ModifyListener': 'arn:aws:elasticloadbalancing:*:*:listener/*'
};

/**
 * B-10803: read-only actions that would read secrets on `*`, each on the only resources Exprsn-AI reads: the public
 * AMI parameters under `/aws/service/` (`resolve:ssm:` image ids), never the account's own SecureStrings.
 */
export const AWS_SCOPED_READS: Record<string, string> = {
  'ssm:GetParameters': 'arn:aws:ssm:*::parameter/aws/service/*'
};
/** B-10803: S3 replaces a bucket's whole tag set, so it is granted only with the `exprsn:*` tags in the request. */
const REPLACES_TAGS = new Set(['s3:PutBucketTagging']);

const uniq = (xs: Iterable<string>) => [...new Set(xs)].sort();
/** Read-only IAM actions: they change nothing, so they are granted without a tag condition. */
export const isReadOnlyAction = (a: string): boolean => /^[a-z0-9-]+:(Describe|List|Get|Head|Lookup|View|Search|Simulate)/.test(a);
const TAGGING = /^[a-z0-9-]+:(CreateTags|TagResource|AddTagsToResource)$/;
const CREATING = /^[a-z0-9-]+:(Create(?!Tags$)|RunInstances$|Register|Import(?!Certificate$)|Allocate|Request)/;
const featureActions = (fs: (keyof typeof AWS_FEATURE_ACTIONS)[]) => uniq(fs.flatMap((f) => AWS_FEATURE_ACTIONS[f] ?? []));

/** Every action the generated AWS policies allow, by tier (derived from `capabilities.ts`). */
export function awsPolicyActions() {
  const deployAll = featureActions(['deploy', 'data', 'compute']);
  const reads = uniq([...AWS_VALIDATION_ACTIONS, ...featureActions(['deploy', 'data', 'compute', 'models', 'billing']).filter(isReadOnlyAction)]);
  const writes = deployAll.filter((a) => !isReadOnlyAction(a));
  return {
    read: reads,
    models: featureActions(['models']).filter((a) => !isReadOnlyAction(a)),
    deployRead: deployAll.filter(isReadOnlyAction),
    create: writes.filter((a) => CREATING.test(a) && !TAGGING.test(a) && !(a in AWS_UNTAGGED)),
    tagOnCreate: writes.filter((a) => TAGGING.test(a)),
    untagged: writes.filter((a) => a in AWS_UNTAGGED),
    passRole: writes.filter((a) => a === 'iam:PassRole'),
    change: writes.filter((a) => !CREATING.test(a) && !TAGGING.test(a) && !(a in AWS_UNTAGGED) && a !== 'iam:PassRole' && !REPLACES_TAGS.has(a)),
    retagOwn: writes.filter((a) => TAGGING.test(a) || REPLACES_TAGS.has(a)),
    billing: featureActions(['billing'])
  };
}

/** The deny that keeps the `exprsn:*` tags on: no tag-removing action of a service the deploy tier tags in. */
const UNTAG: Record<string, string> = { ec2: 'ec2:DeleteTags', eks: 'eks:UntagResource', ecs: 'ecs:UntagResource', rds: 'rds:RemoveTagsFromResource', elasticache: 'elasticache:RemoveTagsFromResource', secretsmanager: 'secretsmanager:UntagResource', elasticloadbalancing: 'elasticloadbalancing:RemoveTags', s3: 's3:PutBucketTagging' };

export function awsPolicies(account: Pick<CloudAccount, 'name'>, awsAccountId = '*') {
  const managed = `${TAG_PREFIX}managed`;
  const acct = `${TAG_PREFIX}account`;
  const a = awsPolicyActions();
  const own = { StringEquals: { [`aws:ResourceTag/${managed}`]: 'true', [`aws:ResourceTag/${acct}`]: account.name } };
  const services = uniq(a.tagOnCreate.map((x) => x.split(':')[0]!));
  const deny = uniq(services.map((svc) => UNTAG[svc]).filter((x): x is string => !!x && !a.change.includes(x) && !a.retagOwn.includes(x)));
  const tagged = { [`aws:RequestTag/${managed}`]: 'true', [`aws:RequestTag/${acct}`]: account.name };
  // B-10803: tagging is allowed at create time only (EC2's and ECS's CreateAction say which call is tagging) or on a
  // resource that already carries this account's tags. Before, CreateTags on `*` with the tags in the request let a
  // stolen deploy session tag any VPC, instance or security group as managed and then change or delete it.
  const createAction = (svc: string) => a.create.filter((x) => x.startsWith(`${svc}:`)).map((x) => x.split(':')[1]!);
  const tagStatements = [
    ...(a.tagOnCreate.includes('ec2:CreateTags') ? [{ Sid: 'ExprsnTagOnCreateEc2', Effect: 'Allow', Action: ['ec2:CreateTags'], Resource: '*', Condition: { StringEquals: { ...tagged, 'ec2:CreateAction': createAction('ec2') } } }] : []),
    ...(a.tagOnCreate.includes('ecs:TagResource') ? [{ Sid: 'ExprsnTagOnCreateEcs', Effect: 'Allow', Action: ['ecs:TagResource'], Resource: '*', Condition: { StringEquals: { ...tagged, 'ecs:CreateAction': createAction('ecs') } } }] : []),
    ...(a.tagOnCreate.some((x) => x !== 'ec2:CreateTags' && x !== 'ecs:TagResource') ? [{ Sid: 'ExprsnTagOnCreate', Effect: 'Allow', Action: a.tagOnCreate.filter((x) => x !== 'ec2:CreateTags' && x !== 'ecs:TagResource'), Resource: '*', Condition: { StringEquals: tagged } }] : []),
    ...(a.retagOwn.length ? [{ Sid: 'ExprsnRetagOwn', Effect: 'Allow', Action: a.retagOwn, Resource: '*', Condition: { StringEquals: { ...own.StringEquals, ...tagged } } }] : [])
  ];
  const scoped = (xs: string[]) => xs.filter((x) => x in AWS_SCOPED_READS);
  const unscoped = (xs: string[]) => xs.filter((x) => !(x in AWS_SCOPED_READS));
  const scopedStatements = (xs: string[], sid: string) => scoped(xs).map((x) => ({ Sid: `${sid}${x.split(':')[1]}`, Effect: 'Allow', Action: [x], Resource: AWS_SCOPED_READS[x]! }));
  return {
    read: {
      Version: '2012-10-17',
      Statement: [
        { Sid: 'ExprsnRead', Effect: 'Allow', Action: unscoped(a.read), Resource: '*' },
        ...scopedStatements(a.read, 'ExprsnRead'),
        ...(a.models.length ? [{ Sid: 'ExprsnModels', Effect: 'Allow', Action: a.models, Resource: '*' }] : [])
      ]
    },
    deploy: {
      Version: '2012-10-17',
      Statement: [
        { Sid: 'ExprsnDescribe', Effect: 'Allow', Action: unscoped(a.deployRead), Resource: '*' },
        ...scopedStatements(a.deployRead, 'ExprsnDescribe'),
        { Sid: 'ExprsnCreateTagged', Effect: 'Allow', Action: a.create, Resource: '*', Condition: { StringEquals: { [`aws:RequestTag/${managed}`]: 'true', [`aws:RequestTag/${acct}`]: account.name }, 'ForAllValues:StringLike': { 'aws:TagKeys': [`${TAG_PREFIX}*`, 'Name'] } } },
        ...tagStatements,
        { Sid: 'ExprsnChangeOwn', Effect: 'Allow', Action: a.change, Resource: '*', Condition: own },
        ...a.untagged.map((x) => ({ Sid: `ExprsnUntagged${x.split(':')[1]}`, Effect: 'Allow', Action: [x], Resource: AWS_UNTAGGED[x]! })),
        ...(a.passRole.length ? [{ Sid: 'ExprsnPassOwnRoles', Effect: 'Allow', Action: a.passRole, Resource: `arn:aws:iam::${awsAccountId}:role/${namePrefix(account.name)}*`, Condition: { StringEquals: { 'iam:PassedToService': ['eks.amazonaws.com', 'ecs-tasks.amazonaws.com', 'ec2.amazonaws.com'] } } }] : []),
        ...(deny.length ? [{ Sid: 'ExprsnNoRetag', Effect: 'Deny', Action: deny, Resource: '*', Condition: { 'ForAnyValue:StringLike': { 'aws:TagKeys': [`${TAG_PREFIX}*`] } } }] : [])
      ]
    },
    billing: { Version: '2012-10-17', Statement: [{ Sid: 'ExprsnBilling', Effect: 'Allow', Action: a.billing, Resource: '*' }] }
  };
}

/** The actions an Azure custom role for the managed resource groups holds: deploy, data and compute (B-10705). */
export function azureRoleActions(): string[] {
  return uniq((['deploy', 'data', 'compute'] as const).flatMap((f) => AZURE_FEATURE_ACTIONS[f] ?? []));
}

/** A least-privilege custom role for one account's managed resource group (the alternative to Contributor there). */
export function azureCustomRole(account: Pick<CloudAccount, 'name'>, subscriptionId: string) {
  return {
    Name: `Exprsn-AI deploy (${account.name})`,
    IsCustom: true,
    Description: `What Exprsn-AI's deploy worker calls for the cloud account ${account.name}, and nothing else.`,
    Actions: azureRoleActions(),
    NotActions: [],
    DataActions: [],
    NotDataActions: [],
    AssignableScopes: [`/subscriptions/${subscriptionId}/resourceGroups/exprsn-${account.name}`]
  };
}

export function awsTrustPolicy(issuer: string, awsAccountId: string, accountId: string) {
  const hp = hostPath(issuer);
  return {
    Version: '2012-10-17',
    Statement: [{ Sid: 'ExprsnFederation', Effect: 'Allow', Principal: { Federated: `arn:aws:iam::${awsAccountId}:oidc-provider/${hp}` }, Action: 'sts:AssumeRoleWithWebIdentity', Condition: { StringEquals: { [`${hp}:aud`]: AWS_AUDIENCE, [`${hp}:sub`]: subjectOf(accountId) } } }]
  };
}

function awsGuide(issuer: string, account: CloudAccount, cred: CloudCredentialRef | null): SetupStep[] {
  const acct = account.providerIds.awsAccountId ?? '<aws-account-id>';
  const pol = awsPolicies(account, account.providerIds.awsAccountId ?? '*');
  const params = cred?.params ?? {};
  const one = params.roleArn ?? null;
  const roleName = (purpose: string) => {
    const arn = params[`${purpose}RoleArn`] ?? one;
    return arn ? arn.split('/').pop()! : `exprsn-${account.name}-${purpose}`;
  };
  const steps: SetupStep[] = [
    {
      title: 'Register the Exprsn-AI issuer as an IAM OIDC identity provider (once per AWS account)',
      commands: [`aws iam create-open-id-connect-provider --url ${issuer} --client-id-list ${AWS_AUDIENCE}`],
      note: 'AWS reads the issuer\'s discovery document and JWKS from the internet, so publish them first (Cloud, Federation issuer). Recent AWS CLI versions no longer need a thumbprint; older ones take --thumbprint-list with the issuer certificate\'s SHA-1.'
    },
    { title: 'Save the trust policy', file: { name: 'exprsn-trust.json', json: awsTrustPolicy(issuer, acct, account.id) }, note: `Only a token whose sub is ${subjectOf(account.id)} and whose aud is ${AWS_AUDIENCE} may assume the role.` },
    { title: 'Save the permission policies', file: { name: 'exprsn-policies.json', json: pol }, note: 'Deploy may create only resources tagged exprsn:managed=true and exprsn:account=' + account.name + ', and change or delete only resources carrying those tags.' }
  ];
  const purposes = ['read', 'deploy', 'billing'] as const;
  const separate = purposes.some((p) => params[`${p}RoleArn`]);
  if (separate || !one) {
    steps.push({
      title: 'Create a role per purpose and attach its policy',
      commands: purposes.flatMap((p) => [`aws iam create-role --role-name ${roleName(p)} --max-session-duration 3600 --assume-role-policy-document file://exprsn-trust.json`, `aws iam put-role-policy --role-name ${roleName(p)} --policy-name exprsn-${p} --policy-document ${q(JSON.stringify(pol[p]))}`]),
      note: `Then set the account's roleArn (one role) or readRoleArn, deployRoleArn and billingRoleArn to arn:aws:iam::${acct}:role/<name>.`
    });
  } else {
    const name = roleName('read');
    steps.push({ title: 'Create the role and attach the three policies', commands: [`aws iam create-role --role-name ${name} --max-session-duration 3600 --assume-role-policy-document file://exprsn-trust.json`, ...purposes.map((p) => `aws iam put-role-policy --role-name ${name} --policy-name exprsn-${p} --policy-document ${q(JSON.stringify(pol[p]))}`)] });
  }
  return steps;
}

function azureGuide(issuer: string, account: CloudAccount, cred: CloudCredentialRef | null, alg: string): SetupStep[] {
  const clientId = cred?.params.clientId ?? '<client-id>';
  const sub = account.providerIds.azureSubscriptionId ?? '<subscription-id>';
  const fic = { name: `exprsn-${account.name}`, issuer, subject: subjectOf(account.id), audiences: [AZURE_AUDIENCE], description: `Exprsn-AI cloud account ${account.name}` };
  return [
    {
      title: 'Add the federated identity credential (app registration)',
      file: { name: 'exprsn-federated-credential.json', json: fic },
      commands: [`az ad app federated-credential create --id ${clientId} --parameters @exprsn-federated-credential.json`],
      note: 'Entra fetches the issuer\'s discovery document and JWKS from the internet, so publish them first (Cloud, Federation issuer).'
    },
    {
      title: 'Or, for a user-assigned managed identity',
      commands: [`az identity federated-credential create --name exprsn-${account.name} --identity-name <identity-name> --resource-group <identity-resource-group> --issuer ${issuer} --subject ${subjectOf(account.id)} --audiences ${AZURE_AUDIENCE}`]
    },
    {
      title: 'Assign the roles',
      commands: [
        `az role assignment create --assignee ${clientId} --role Reader --scope /subscriptions/${sub}`,
        `az role assignment create --assignee ${clientId} --role "Cost Management Reader" --scope /subscriptions/${sub}`,
        `az group create --name exprsn-${account.name} --location <region> --tags ${TAG_PREFIX}managed=true ${TAG_PREFIX}account=${account.name}`,
        `az role assignment create --assignee ${clientId} --role Contributor --scope /subscriptions/${sub}/resourceGroups/exprsn-${account.name}`
      ],
      note: 'Contributor is given on each resource group Exprsn-AI manages, never on the subscription; repeat the last two lines for every managed resource group.'
    },
    {
      title: 'Least privilege: a custom role instead of Contributor on the managed resource group',
      file: { name: 'exprsn-role.json', json: azureCustomRole(account, sub) },
      commands: [`az role definition create --role-definition @exprsn-role.json`, `az role assignment create --assignee ${clientId} --role ${q(`Exprsn-AI deploy (${account.name})`)} --scope /subscriptions/${sub}/resourceGroups/exprsn-${account.name}`],
      note: 'The role holds exactly the actions the deploy, data and compute features call (the list the permission check uses); assign it in place of Contributor.'
    },
    ...(alg === 'RS256'
      ? [{ title: 'Signing algorithm', note: 'CLOUD_AZURE_SIGNING_ALG=RS256: tokens for Entra are signed with an RSA key used only for this audience (open decision 3). Confirm against a sandbox tenant which algorithm your tenant accepts.' }]
      : [{ title: 'Signing algorithm', note: 'Tokens for Entra are signed ES256. If the token exchange answers that the algorithm is not supported, set CLOUD_AZURE_SIGNING_ALG=RS256 (open decision 3: to be confirmed against a sandbox tenant).' }])
  ];
}

/** The steps for one account, or the reason federation does not apply. */
export function setupGuide(o: { issuer: string; account: CloudAccount; cred: CloudCredentialRef | null; azureAlg: string; documents?: { discovery: unknown; jwks: unknown } }): SetupGuide {
  const { issuer, account, cred } = o;
  const base = { provider: account.provider, issuer, subject: subjectOf(account.id) };
  if (account.provider === 'digitalocean' || account.provider === 'cloudflare') return { ...base, audience: null, available: false, reason: `${account.provider === 'cloudflare' ? 'Cloudflare' : 'DigitalOcean'} offers no workload identity federation: the account uses a scoped token held in the vault.`, steps: [] };
  const docs: SetupStep[] = o.documents ? [{ title: `The issuer's public documents (${DISCOVERY_NAME} and ${JWKS_NAME}), should you publish them by hand`, file: { name: 'issuer-documents.json', json: o.documents } }] : [];
  if (account.provider === 'aws') return { ...base, audience: AWS_AUDIENCE, available: true, reason: null, steps: [...awsGuide(issuer, account, cred), ...docs] };
  return { ...base, audience: AZURE_AUDIENCE, available: true, reason: null, steps: [...azureGuide(issuer, account, cred, o.azureAlg), ...docs] };
}
