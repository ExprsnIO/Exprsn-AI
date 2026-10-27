import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Principal } from '../src/authz/policy.js';
import type { CloudActor } from '../src/cloud/accounts.js';
import { evaluateExpression, renderWaf, serverLimits } from '../src/cloud/edge-waf.js';
import { instanceScope } from '../src/cloud/model-residency.js';
import { AWS_SCOPED_READS, awsPolicies, awsPolicyActions } from '../src/cloud/setup.js';
import type { CloudCredentials } from '../src/cloud/credentials.js';
import type { InstanceRow } from '../src/gateway/repo.js';
import { edgeTrust } from '../src/http/client-address.js';
import { accessProtects } from '../src/http/cloudflare-access.js';
import { loadPrincipal } from '../src/http/middleware.js';
import { installCloud, seedAccount } from './cloud-credentials-helpers.js';
import { harness, localUser, loginAdmin, testConfig, type Client, type Harness } from './helpers.js';

/*
 * 1.9.99-final, Sprint 62 (B-10803): the release security review's findings, each shown failing before its fix.
 * Offline only: no fake is even needed for most of them; nothing reaches a cloud.
 */

type Stmt = { Sid?: string; Effect: string; Action: string[]; Resource: string; Condition?: Record<string, Record<string, unknown>> };

describe('generated AWS policies (B-10803)', () => {
  const pol = awsPolicies({ name: 'acme' }, '123456789012');
  const deploy = pol.deploy.Statement as Stmt[];
  const read = pol.read.Statement as Stmt[];

  it('allow tagging only at create time (CreateAction) or on resources that already carry the account\'s tags', () => {
    const tagging = /:(CreateTags|TagResource|AddTagsToResource)$/;
    for (const s of deploy.filter((x) => x.Effect === 'Allow' && x.Action.some((a) => tagging.test(a) && (a.startsWith('ec2:') || a.startsWith('ecs:'))))) {
      const eq = s.Condition?.StringEquals ?? {};
      const atCreate = 'ec2:CreateAction' in eq || 'ecs:CreateAction' in eq;
      const own = eq['aws:ResourceTag/exprsn:managed'] === 'true' && eq['aws:ResourceTag/exprsn:account'] === 'acme';
      expect(atCreate || own, s.Sid).toBe(true);
      expect(eq['aws:RequestTag/exprsn:account'], s.Sid).toBe('acme');
    }
    const ec2 = deploy.find((s) => s.Sid === 'ExprsnTagOnCreateEc2')!;
    expect(ec2.Condition!.StringEquals!['ec2:CreateAction']).toEqual(expect.arrayContaining(['CreateVpc', 'RunInstances', 'CreateSecurityGroup']));
    expect(deploy.find((s) => s.Sid === 'ExprsnRetagOwn')!.Action).toEqual(expect.arrayContaining(['ec2:CreateTags']));
  });

  it('replace a bucket\'s tags only with the exprsn tags in the request, on its own buckets', () => {
    const a = awsPolicyActions();
    if (!a.retagOwn.includes('s3:PutBucketTagging')) return;
    expect(deploy.find((s) => s.Sid === 'ExprsnChangeOwn')!.Action).not.toContain('s3:PutBucketTagging');
    expect(deploy.find((s) => s.Sid === 'ExprsnRetagOwn')!.Condition!.StringEquals).toMatchObject({ 'aws:RequestTag/exprsn:managed': 'true', 'aws:ResourceTag/exprsn:account': 'acme' });
  });

  it('never read SSM parameters on *: only the public AMI parameters', () => {
    for (const doc of [read, deploy]) {
      for (const s of doc.filter((x) => x.Effect === 'Allow')) {
        for (const [action, resource] of Object.entries(AWS_SCOPED_READS)) if (s.Action.includes(action)) expect(s.Resource, `${s.Sid} ${action}`).toBe(resource);
      }
    }
    expect([...read, ...deploy].some((s) => s.Action.includes('ssm:GetParameters'))).toBe(true);
  });
});

describe('cloud model residency fails closed without an entry (B-10803)', () => {
  it('treats an Azure deployment and a Bedrock inference-profile ARN with no entry as cross-region', () => {
    const azure = { kind: 'openai', settings: { cloud: { provider: 'azure', accountId: 'x', region: 'westeurope', flavour: 'azure' } } } as unknown as InstanceRow;
    const bedrock = { kind: 'bedrock', settings: { cloud: { provider: 'aws', accountId: 'x', region: 'eu-central-1' } } } as unknown as InstanceRow;
    expect(instanceScope(azure, 'gpt-4o')).toBe('cross-region');
    expect(instanceScope(bedrock, 'arn:aws:bedrock:eu-central-1:123456789012:application-inference-profile/abc')).toBe('cross-region');
    expect(instanceScope(bedrock, 'arn:aws:bedrock:eu-central-1::foundation-model/anthropic.claude-3-haiku-20240307-v1:0')).toBe('regional');
  });
});

describe('the Cloudflare edge (B-10803)', () => {
  it('trusts no tunnel connector by default, so a local proxy cannot pass on a client\'s CF-Connecting-IP', () => {
    const cfg = testConfig();
    expect(cfg.CLOUDFLARE_TUNNEL_PEERS).toBe('');
    const t = edgeTrust({ TRUST_PROXY: 'loopback,cloudflare', CLOUDFLARE_TUNNEL_PEERS: cfg.CLOUDFLARE_TUNNEL_PEERS, CLOUDFLARE_IP_RANGES: '' }, (a) => a === '127.0.0.1')!;
    expect(t.edgeOf('127.0.0.1', '198.51.100.7')).toBeNull();
    // Named explicitly, the connector still counts.
    const named = edgeTrust({ TRUST_PROXY: 'cloudflare', CLOUDFLARE_TUNNEL_PEERS: '10.1.2.3', CLOUDFLARE_IP_RANGES: '' }, () => false)!;
    expect(named.edgeOf('10.1.2.3', undefined)).toMatchObject({ via: 'tunnel' });
  });

  it('Access and the WAF compare paths as the router does, whatever their case', () => {
    expect(accessProtects('admin', '/API/Admin/users')).toBe(true);
    expect(accessProtects('admin', '/api/admin/users')).toBe(true);
    expect(accessProtects('admin', '/api/me')).toBe(false);
    const waf = renderWaf(serverLimits(testConfig()), 'pro', { adminCidrs: ['192.0.2.0/24'] });
    const rule = waf.phases.http_request_firewall_custom.find((r) => r.ref === 'exprsn-admin-allow')!;
    expect(evaluateExpression(rule.expression, { method: 'GET', path: '/API/Admin/users', ip: '198.51.100.7' } as never)).toBe(true);
    expect(evaluateExpression(rule.expression, { method: 'GET', path: '/api/admin/users', ip: '192.0.2.7' } as never)).toBe(false);
  });
});

describe('cloud accounts and credentials (B-10803)', () => {
  let h: Harness;
  let c: CloudCredentials;
  let actor: CloudActor;
  let admin: Client;
  const post = (p: string, b: object) => admin.agent.post(p).set('x-csrf-token', admin.csrf).send(b);

  beforeAll(async () => {
    h = await harness({ SERVICE_ALLOWED_HOSTS: '127.0.0.1' });
    c = await installCloud(h);
    const u = await localUser(h, 'reviewer', ['system-admin'], 'restricted');
    admin = await loginAdmin(h, 'reviewer');
    const p = (await loadPrincipal(h.s, h.tenantId, u.id, {}))!;
    actor = { principal: { ...p, mfa: true } as Principal, ip: null };
  }, 60_000);
  afterAll(async () => {
    await h?.close();
  });

  const stagedRows = (path: string) => h.s.db('vault_secrets').where({ path }).select('id');

  it('forget removes the staged secrets the account\'s references point at, unless another account names them', async () => {
    const one = await c.store({ scope: 'platform', tenantId: null, values: { token: 'do-token-value-1' }, by: null });
    const shared = await c.store({ scope: 'platform', tenantId: null, values: { token: 'do-token-value-2' }, by: null });
    const a = await seedAccount(h, { provider: 'digitalocean', mode: 'vaulted', name: 'forget-a', providerIds: { doTeamId: '00000000-0000-4000-8000-00000000000a' }, refs: { token: one.refs.token! } });
    const b = await seedAccount(h, { provider: 'digitalocean', mode: 'vaulted', name: 'forget-b', providerIds: { doTeamId: '00000000-0000-4000-8000-00000000000b' }, refs: { token: shared.refs.token! } });
    await seedAccount(h, { provider: 'digitalocean', mode: 'vaulted', name: 'forget-c', providerIds: { doTeamId: '00000000-0000-4000-8000-00000000000c' }, refs: { token: shared.refs.token! } });
    expect(await stagedRows(one.path)).toHaveLength(1);
    await c.forget(a.id);
    expect(await stagedRows(one.path)).toHaveLength(0);
    await c.forget(b.id);
    expect(await stagedRows(shared.path)).toHaveLength(1);
  });

  it('a credential change drops the cached sessions and tokens on every instance', async () => {
    const acct = await seedAccount(h, { provider: 'digitalocean', mode: 'vaulted', name: 'swap-cred', providerIds: { doTeamId: '00000000-0000-4000-8000-00000000000d' }, refs: { token: 'vault:cloud/secrets/platform/old#token' } });
    const pub = vi.spyOn(h.s.bus, 'publish');
    await h.s.cloud.accounts.update(actor, acct.id, { credential: { mode: 'vaulted', params: {}, refs: { token: 'vault:cloud/secrets/platform/new#token' } } } as never);
    expect(pub.mock.calls.some(([topic, m]) => topic === 'cloud.credentials' && (m as { accountId?: string }).accountId === acct.id)).toBe(true);
    pub.mockRestore();
  });

  it('a tenant\'s own cloud account never backs a gateway pool, which serves every tenant', async () => {
    const t = await seedAccount(h, { provider: 'aws', mode: 'vaulted', scope: 'tenant', name: 'tenant-aws', providerIds: { awsAccountId: '123456789012' } });
    const pool = (await post('/api/admin/pools', { name: 'shared-cloud', accelerator: 'cpu', labelCeiling: 'internal' }).expect(201)).body;
    const res = await post(`/api/admin/pools/${pool.id}/instances`, { name: 'tenant-bedrock', kind: 'bedrock', deploy: 'docker', cloud: { accountId: t.id, region: 'eu-central-1' } });
    expect(res.status).toBe(403);
    expect(res.body.detail).toMatch(/tenant account/);
  });

  it('AI Gateway is refused in front of a pool whose ceiling the Cloudflare account\'s region does not admit', async () => {
    const cf = await seedAccount(h, { provider: 'cloudflare', mode: 'vaulted', name: 'cf-gateway', providerIds: { cloudflareAccountId: '0123456789abcdef0123456789abcdef' } });
    const pool = (await post('/api/admin/pools', { name: 'confidential-cloud', accelerator: 'cpu', labelCeiling: 'confidential' }).expect(201)).body;
    const row = { id: 'i1', pool_id: pool.id, kind: 'bedrock', settings: { cloud: { provider: 'aws', accountId: 'x', region: 'eu-central-1' } } } as unknown as InstanceRow;
    await expect(h.s.cloud.aiGateway.check(row, { accountId: cf.id, gatewayId: 'g1' } as never, () => true)).rejects.toMatchObject({ status: 403 });
    const internal = (await post('/api/admin/pools', { name: 'internal-cloud', accelerator: 'cpu', labelCeiling: 'internal' }).expect(201)).body;
    await expect(h.s.cloud.aiGateway.check({ ...row, pool_id: internal.id } as InstanceRow, { accountId: cf.id, gatewayId: 'g1' } as never, () => true)).resolves.toBeUndefined();
  });
});
