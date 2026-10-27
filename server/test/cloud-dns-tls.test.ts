import { generateKeyPairSync, randomBytes, X509Certificate } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Principal } from '../src/authz/policy.js';
import { listenerMembers } from '../src/cloud/cert-push.js';
import { CloudDnsProvider } from '../src/cloud/cloud-dns.js';
import type { DesiredResource } from '../src/cloud/graph.js';
import { ProviderRegistry } from '../src/cloud/providers/registry.js';
import { capabilityTable, type CloudProvider, type ObservedResource, type ResourceSpec } from '../src/cloud/providers/types.js';
import type { CloudAccount } from '../src/cloud/types.js';
import { followSources, resolveForDiff, withValueSources } from '../src/cloud/value-from.js';
import { toPem } from '../src/ops/der.js';
import { selfSignedCertificate } from '../src/federation/x509.js';
import { servicePolicy } from '../src/platform/egress.js';
import type { AddressInfo } from 'node:net';
import { HttpAcmeClient } from '../src/ops/acme.js';
import { seedAccount, signerFixture } from './cloud-credentials-helpers.js';
import { loopbackServerFor } from './loopback.js';
import { startFakeDns, type FakeDns } from './sprint25a-fakes.js';
import { startFakeAcme, type FakeAcme } from './fake-acme.js';
import { FakeAws } from './fake-aws.js';
import { FakeAzure } from './fake-azure.js';
import { json, xmlEsc, type RecordedRequest, type Reply } from './fake-cloud-base.js';
import { FakeDigitalOcean } from './fake-do.js';
import { harness, localUser, loginAdmin, type Harness } from './helpers.js';

/*
 * 1.9.99-final, Sprint 58 (B-10206): DNS and TLS for deployments. A DNS record's `valueFrom` (the load balancer's
 * address) resolved at apply and ordered after its source; ACME dns-01 TXT records through Route 53, Azure DNS and
 * DigitalOcean DNS with a cloud account's credential (`ACME_DNS_PROVIDER=route53|azure-dns|digitalocean`); renewed
 * certificates pushed to the load balancer by the certificate hooks' new kinds (ACM import and the listener,
 * Application Gateway, DigitalOcean certificates). Everything runs against the fakes on 127.0.0.1 (the AWS fake grows
 * ACM and ELBv2 here, the DigitalOcean fake certificates and load balancers), never a real cloud or CA.
 */

vi.setConfig({ testTimeout: 90_000, hookTimeout: 120_000 });

const ALLOWED = '127.0.0.1,::1,localhost';
const VALIDATED = { at: Date.now(), ok: true, identity: { ok: true }, features: [{ feature: 'deploy', name: 'Deploy', status: 'ok', required: [], missing: [], reason: null }] };

// ---------------------------------------------------------------- fakes

/** The AWS fake with ACM certificates and ELBv2 listeners (signatures not checked; the key id is). */
class LbAws extends FakeAws {
  readonly certificates = new Map<string, { certificate: string; chain: string; key: string; imports: number }>();
  readonly listeners = new Map<string, { lbArn: string; port: number; protocol: string; certificateArn: string | null }>();
  /** Called after every Route 53 change (the Exprsn-AI CA path mirrors the zone into a DNS server). */
  onRoute53Change: (() => void) | null = null;

  addListener(name: string, region = 'eu-central-1'): { lbArn: string; listenerArn: string } {
    const lbArn = `arn:aws:elasticloadbalancing:${region}:${this.account}:loadbalancer/app/${name}/${randomBytes(8).toString('hex')}`;
    const listenerArn = `arn:aws:elasticloadbalancing:${region}:${this.account}:listener/app/${name}/${randomBytes(8).toString('hex')}/${randomBytes(8).toString('hex')}`;
    this.listeners.set(listenerArn, { lbArn, port: 443, protocol: 'HTTPS', certificateArn: null });
    this.listeners.set(`${listenerArn}-80`, { lbArn, port: 80, protocol: 'HTTP', certificateArn: null });
    return { lbArn, listenerArn };
  }

  /** The certificate a listener serves now. */
  served(listenerArn: string): X509Certificate | null {
    const l = this.listeners.get(listenerArn);
    const c = l?.certificateArn ? this.certificates.get(l.certificateArn) : null;
    return c ? new X509Certificate(c.certificate) : null;
  }

  /** TXT values at a name in any hosted zone. */
  txt(name: string): string[] {
    const fq = `${name.replace(/\.$/, '')}.`.toLowerCase();
    for (const z of this.zones.values()) for (const set of z.Records.values()) if (set.Name === fq && set.Type === 'TXT') return set.Values.map((v) => v.replace(/^"|"$/g, ''));
    return [];
  }

  protected override async handle(r: RecordedRequest): Promise<Reply> {
    if (r.op.startsWith('acm:')) return this.acm(r);
    if (r.op.startsWith('elasticloadbalancing:')) return this.elb(r);
    const out = await super.handle(r);
    if (r.op === 'route53:ChangeResourceRecordSets') this.onRoute53Change?.();
    return out;
  }

  private signed(r: RecordedRequest): boolean {
    const id = /Credential=([^/]+)\//.exec(r.headers.authorization ?? '')?.[1];
    return !!id && this.keys.has(id);
  }

  private acm(r: RecordedRequest): Reply {
    if (!this.signed(r)) return { status: 400, body: { __type: 'UnrecognizedClientException', message: 'The security token included in the request is invalid.' } };
    const b = json(r) as { Certificate?: string; PrivateKey?: string; CertificateChain?: string; CertificateArn?: string };
    if (r.op !== 'acm:ImportCertificate') return { status: 400, body: { __type: 'InvalidAction', message: r.op } };
    const pem = Buffer.from(String(b.Certificate ?? ''), 'base64').toString('utf8');
    try {
      new X509Certificate(pem);
    } catch {
      return { status: 400, body: { __type: 'ValidationException', message: 'The certificate is not PEM.' } };
    }
    if (!/PRIVATE KEY/.test(Buffer.from(String(b.PrivateKey ?? ''), 'base64').toString('utf8'))) return { status: 400, body: { __type: 'ValidationException', message: 'No private key.' } };
    const arn = b.CertificateArn ?? `arn:aws:acm:eu-central-1:${this.account}:certificate/${randomBytes(16).toString('hex')}`;
    const prev = this.certificates.get(arn);
    if (b.CertificateArn && !prev) return { status: 400, body: { __type: 'ResourceNotFoundException', message: 'No such certificate.' } };
    this.certificates.set(arn, { certificate: pem, chain: Buffer.from(String(b.CertificateChain ?? ''), 'base64').toString('utf8'), key: 'held', imports: (prev?.imports ?? 0) + 1 });
    return { status: 200, headers: { 'x-amzn-requestid': this.nextId('acm-') }, body: { CertificateArn: arn } };
  }

  private elb(r: RecordedRequest): Reply {
    const p = new URLSearchParams(r.body);
    const ok = (action: string, inner: string): Reply => ({ status: 200, headers: { 'content-type': 'text/xml' }, body: `<${action}Response xmlns="http://elasticloadbalancing.amazonaws.com/doc/2015-12-01/"><${action}Result>${inner}</${action}Result><ResponseMetadata><RequestId>${this.nextId('elb-')}</RequestId></ResponseMetadata></${action}Response>` });
    const member = (arn: string, l: { lbArn: string; port: number; protocol: string; certificateArn: string | null }) => `<member><Certificates>${l.certificateArn ? `<member><CertificateArn>${xmlEsc(l.certificateArn)}</CertificateArn></member>` : ''}</Certificates><LoadBalancerArn>${xmlEsc(l.lbArn)}</LoadBalancerArn><Port>${l.port}</Port><Protocol>${l.protocol}</Protocol><ListenerArn>${xmlEsc(arn)}</ListenerArn><DefaultActions><member><Type>forward</Type></member></DefaultActions></member>`;
    if (!this.signed(r)) return { status: 403, body: '<ErrorResponse><Error><Code>InvalidClientTokenId</Code><Message>invalid</Message></Error></ErrorResponse>' };
    if (r.op === 'elasticloadbalancing:DescribeListeners') {
      const lb = p.get('LoadBalancerArn');
      const one = p.get('ListenerArns.member.1');
      const list = [...this.listeners.entries()].filter(([arn, l]) => (lb ? l.lbArn === lb : arn === one));
      return ok('DescribeListeners', `<Listeners>${list.map(([arn, l]) => member(arn, l)).join('')}</Listeners>`);
    }
    if (r.op === 'elasticloadbalancing:ModifyListener') {
      const l = this.listeners.get(String(p.get('ListenerArn')));
      if (!l) return { status: 400, body: '<ErrorResponse><Error><Code>ListenerNotFound</Code><Message>no listener</Message></Error></ErrorResponse>' };
      const cert = String(p.get('Certificates.member.1.CertificateArn'));
      if (!this.certificates.has(cert)) return { status: 400, body: '<ErrorResponse><Error><Code>CertificateNotFound</Code><Message>no certificate</Message></Error></ErrorResponse>' };
      l.certificateArn = cert;
      return ok('ModifyListener', `<Listeners>${member(String(p.get('ListenerArn')), l)}</Listeners>`);
    }
    return { status: 400, body: `<ErrorResponse><Error><Code>InvalidAction</Code><Message>${xmlEsc(r.op)}</Message></Error></ErrorResponse>` };
  }
}

/** The DigitalOcean fake with custom certificates and load balancers. */
class LbDo extends FakeDigitalOcean {
  readonly certificates = new Map<string, { id: string; name: string; leaf: string; chain: string }>();
  readonly lbs = new Map<string, Record<string, unknown> & { forwarding_rules: Record<string, unknown>[] }>();

  addLb(): string {
    const id = crypto.randomUUID();
    this.lbs.set(id, { id, name: 'exprsn-do-edge-lb', region: { slug: 'fra1', name: 'Frankfurt 1' }, size_unit: 1, status: 'active', vpc_uuid: crypto.randomUUID(), tag: 'exprsn:deployment:main', health_check: { protocol: 'http', port: 80, path: '/readyz' }, forwarding_rules: [{ entry_protocol: 'https', entry_port: 443, target_protocol: 'http', target_port: 8080, certificate_id: '', tls_passthrough: false }, { entry_protocol: 'http', entry_port: 80, target_protocol: 'http', target_port: 8080, certificate_id: '', tls_passthrough: false }] });
    return id;
  }

  protected override handle(r: RecordedRequest): Reply {
    if (!/^\/v2\/(certificates|load_balancers)/.test(r.path)) return super.handle(r);
    if (!/^Bearer dop_v1_/.test(r.headers.authorization ?? '')) return { status: 401, body: { id: 'unauthorized', message: 'Unable to authenticate you' } };
    const b = json(r);
    let m = /^\/v2\/certificates\/?$/.exec(r.path);
    if (m && r.method === 'POST') {
      try {
        new X509Certificate(String(b.leaf_certificate));
      } catch {
        return { status: 422, body: { id: 'unprocessable_entity', message: 'leaf_certificate is not PEM' } };
      }
      if (![...this.certificates.values()].every((c) => c.name !== b.name)) return { status: 422, body: { id: 'unprocessable_entity', message: 'name already exists' } };
      const c = { id: crypto.randomUUID(), name: String(b.name), leaf: String(b.leaf_certificate), chain: String(b.certificate_chain ?? '') };
      this.certificates.set(c.id, c);
      return { status: 201, body: { certificate: { id: c.id, name: c.name, type: 'custom', state: 'verified' } } };
    }
    m = /^\/v2\/certificates\/([^/]+)$/.exec(r.path);
    if (m && r.method === 'DELETE') {
      const used = [...this.lbs.values()].some((lb) => lb.forwarding_rules.some((f) => f.certificate_id === m![1]));
      if (used) return { status: 403, body: { id: 'forbidden', message: 'in use' } };
      return this.certificates.delete(m[1]!) ? { status: 204 } : { status: 404, body: { id: 'not_found', message: 'no certificate' } };
    }
    m = /^\/v2\/load_balancers\/([^/]+)$/.exec(r.path);
    const lb = m ? this.lbs.get(m[1]!) : undefined;
    if (!lb) return { status: 404, body: { id: 'not_found', message: 'no load balancer' } };
    if (r.method === 'GET') return { status: 200, body: { load_balancer: lb } };
    if (r.method === 'PUT') {
      if (typeof b.region !== 'string' || !b.name || !Array.isArray(b.forwarding_rules)) return { status: 422, body: { id: 'unprocessable_entity', message: 'name, region and forwarding_rules are required' } };
      for (const f of b.forwarding_rules as Record<string, unknown>[]) if (f.certificate_id && !this.certificates.has(String(f.certificate_id))) return { status: 422, body: { id: 'unprocessable_entity', message: 'no such certificate' } };
      Object.assign(lb, { ...b, region: lb.region });
      return { status: 200, body: { load_balancer: lb } };
    }
    return { status: 405, body: { id: 'method_not_allowed', message: r.method } };
  }
}

/** An adapter that builds every type in memory; a load balancer reports an address. */
class MemProvider implements CloudProvider {
  readonly kind = 'aws' as const;
  readonly capabilities = capabilityTable({});
  readonly store = new Map<string, ObservedResource>();
  private n = 0;
  /** What a new load balancer's address looks like. */
  address: (n: number) => string = (n) => `exprsn-lb-${n}.eu-central-1.elb.amazonaws.com`;
  readonly creates: string[] = [];
  supports() {
    return 'built' as const;
  }
  async identity() {
    return { ok: true } as never;
  }
  async checkPermissions() {
    return [];
  }
  async find(_c: unknown, spec: ResourceSpec) {
    return [...this.store.values()].find((o) => o.type === spec.type && o.name === spec.name) ?? null;
  }
  async describe(_c: unknown, ref: { providerId: string }) {
    return this.store.get(ref.providerId) ?? null;
  }
  async list() {
    return [...this.store.values()];
  }
  async create(_c: unknown, spec: ResourceSpec) {
    this.creates.push(`${spec.type}:${spec.name}`);
    const props = { ...(spec.props as Record<string, unknown>) };
    if (spec.type === 'load_balancer') props.address = this.address(++this.n);
    const o: ObservedResource = { type: spec.type, providerId: `mem-${spec.type}-${spec.name}-${this.n}`, name: spec.name, state: 'ready', tags: spec.tags, props };
    this.store.set(o.providerId, o);
    return { done: true as const, resource: o };
  }
  async update(_c: unknown, ref: { providerId: string }, spec: ResourceSpec) {
    const prev = this.store.get(ref.providerId);
    const o: ObservedResource = { type: spec.type, providerId: ref.providerId, name: spec.name, state: 'ready', tags: spec.tags, props: { ...(spec.props as Record<string, unknown>), ...(spec.type === 'load_balancer' && prev ? { address: prev.props.address } : {}) } };
    this.store.set(ref.providerId, o);
    return { done: true as const, resource: o };
  }
  async delete(_c: unknown, ref: { providerId: string }) {
    this.store.delete(ref.providerId);
    return { done: true as const, resource: null };
  }
  async poll() {
    return { state: 'succeeded' as const, resource: null };
  }
}

const sysPrincipal = (h: Harness): Principal => ({ kind: 'user', userId: 'u-dns-admin', tenantId: h.tenantId, tenantSlug: h.s.cfg.DEFAULT_TENANT, username: 'dns-admin', displayName: 'DNS admin', roles: ['system-admin'], clearance: 'restricted', scopes: null, sessionId: null, apiKeyId: null, mfa: true });

async function install(h: Harness): Promise<void> {
  if (!(await h.s.db.schema.hasTable('cloud_accounts'))) await (await import('../src/db/migrations/146_cloud_accounts.js')).up(h.s.db);
  if (!(await h.s.db.schema.hasTable('cloud_deployments'))) await (await import('../src/db/migrations/148_cloud_journal.js')).up(h.s.db);
  if (!(await h.s.db.schema.hasTable('cloud_budgets'))) await (await import('../src/db/migrations/152_cloud_budgets.js')).up(h.s.db);
  h.s.cloud.accounts.resetSchemaCache();
  h.s.cloud.deployments.resetSchemaCache();
  h.s.cloud.budgets.resetSchemaCache();
}

/** A certificate and its key, self-signed, for the push tests. */
function certFor(name: string, days = 30): { chainPem: string; keyPem: string; serial: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const der = selfSignedCertificate({ publicKey, commonName: name, days, privateKey });
  const pem = toPem(der);
  return { chainPem: pem, keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), serial: new X509Certificate(pem).serialNumber };
}

// ---------------------------------------------------------------- valueFrom

describe('a DNS record whose value is the load balancer\'s address (B-10206)', () => {
  let h: Harness;
  let mem: MemProvider;
  let account: CloudAccount;
  const actor = () => ({ principal: sysPrincipal(h), ip: '127.0.0.1' });
  const net: DesiredResource = { key: 'core', type: 'network', spec: { cidr: '10.30.0.0/20' }, dependsOn: [], protect: false, region: null };
  const lb = (name?: string): DesiredResource => ({ key: 'lb', type: 'load_balancer', spec: { scheme: 'internet-facing', listeners: [{ port: 443, protocol: 'tls' }] }, dependsOn: [], network: 'core', protect: false, region: null, ...(name ? { name } : {}) });
  // As `renderGraph` writes it, but without naming the load balancer as a dependency: the planner adds it.
  const record: DesiredResource = { key: 'dns-app', type: 'dns_record', spec: { zone: 'example.test', record: 'app', recordType: 'CNAME', values: [], valueFrom: { key: 'lb', field: 'address' }, ttl: 300 }, dependsOn: [], protect: false, region: null };

  beforeAll(async () => {
    h = await harness({ SERVICE_ALLOWED_HOSTS: ALLOWED });
    await install(h);
    mem = new MemProvider();
    Object.defineProperty(h.s.cloud, 'providers', { value: { providerFor: () => mem }, configurable: true });
    (h.s.cloud as { credentials: unknown }).credentials = { for: async () => ({ kind: 'aws', accessKeyId: 'AKIAMEM', secretAccessKey: 'x', expiresAt: null }) };
    (h.s.cloud as { estimatePlan: unknown }).estimatePlan = async () => null;
    h.s.cloud.engine.options.sleep = async () => undefined;
    const seeded = await seedAccount(h, { provider: 'aws', mode: 'vaulted', name: 'aws-dns', providerIds: { awsAccountId: '123456789012' }, refs: { accessKeyId: 'vault:cloud/aws-dns#id', secretAccessKey: 'vault:cloud/aws-dns#secret' } });
    await h.s.db('cloud_accounts').where({ id: seeded.id }).update({ validation: JSON.stringify(VALIDATED) });
    account = (await h.s.cloud.accounts.get(seeded.id))!;
  });
  afterAll(async () => {
    await h.close();
  });

  const applyNow = async (deploymentId: string, desired: DesiredResource[]) => {
    const plan = await h.s.cloud.plans.create(actor(), deploymentId, desired);
    const { jobId } = await h.s.cloud.plans.apply(actor(), plan.id, plan.hash);
    const out = await h.s.cloud.engine.apply(plan.id, { jobId, onBehalfOf: 'u-dns-admin' });
    return { plan, out };
  };

  it('the pure helpers: the source becomes a dependency, the diff compares the observed address', () => {
    const g = withValueSources([net, lb(), record]);
    expect(g.find((r) => r.key === 'dns-app')!.dependsOn).toEqual(['lb']);
    expect(withValueSources([record])[0]!.dependsOn).toEqual([]); // a source outside the graph is not invented
    const row = { key: 'lb', observed: { props: { address: 'a.example' } } } as never;
    expect(resolveForDiff([record], [row])[0]!.spec).toMatchObject({ values: ['a.example'], recordType: 'CNAME' });
    expect(resolveForDiff([record], [{ key: 'lb', observed: { props: { address: '203.0.113.7' } } } as never])[0]!.spec).toMatchObject({ values: ['203.0.113.7'], recordType: 'A' });
    expect(resolveForDiff([record], [])[0]!.spec).not.toHaveProperty('values');
    expect(followSources([{ key: 'lb', type: 'load_balancer', region: 'r', protect: false, dependsOn: [], providerId: 'x', action: 'replace', changes: [] }, { key: 'dns-app', type: 'dns_record', region: 'r', protect: false, dependsOn: ['lb'], providerId: 'y', action: 'noop', changes: [] }], [lb(), record])[1]).toMatchObject({ action: 'update', reason: expect.stringMatching(/comes from lb, which this plan replaces/) });
  });

  it('is ordered after the load balancer, created with its address, a no-op when nothing changed, and follows a replaced load balancer', async () => {
    const d = await h.s.cloud.deployments.create(actor(), { name: 'vf-main', accountId: account.id });
    const { plan, out } = await applyNow(d.id, [net, lb(), record]);
    expect(out.state).toBe('applied');
    const order = plan.steps.map((s) => s.key);
    expect(order.indexOf('dns-app')).toBeGreaterThan(order.indexOf('lb'));
    expect(plan.steps.find((s) => s.key === 'dns-app')!.dependsOn).toContain('lb');
    expect(mem.creates.indexOf('dns_record:vf-main-dns-app')).toBeGreaterThan(mem.creates.indexOf('load_balancer:vf-main-lb'));
    const rec = () => [...mem.store.values()].find((o) => o.type === 'dns_record' && o.name === 'vf-main-dns-app')!;
    const lbNow = () => [...mem.store.values()].find((o) => o.type === 'load_balancer')!;
    expect(rec().props).toMatchObject({ recordType: 'CNAME', values: [lbNow().props.address], zone: 'example.test' });
    expect(rec().props).not.toHaveProperty('valueFrom');
    // Planned again: nothing to do (the record already holds the address).
    const again = await h.s.cloud.plans.create(actor(), d.id, [net, lb(), record]);
    expect(again.steps.find((s) => s.key === 'dns-app')!.action).toBe('noop');
    // The load balancer replaced (a new name): the record is updated after it, with the new address.
    const old = lbNow().props.address;
    const { plan: p2, out: o2 } = await applyNow(d.id, [net, lb('vf-main-lb2'), record]);
    expect(o2.state).toBe('applied');
    expect(p2.steps.find((s) => s.key === 'lb')!.action).toBe('replace');
    expect(p2.steps.find((s) => s.key === 'dns-app')!).toMatchObject({ action: 'update' });
    expect(lbNow().props.address).not.toBe(old);
    expect(rec().props.values).toEqual([lbNow().props.address]);
  });

  it('a load balancer that reports an IP address gets an A record', async () => {
    mem.address = (n) => `203.0.113.${n}`;
    const d = await h.s.cloud.deployments.create(actor(), { name: 'vf-ip', accountId: account.id });
    expect((await applyNow(d.id, [net, lb(), record])).out.state).toBe('applied');
    const rec = [...mem.store.values()].find((o) => o.type === 'dns_record' && o.name === 'vf-ip-dns-app')!;
    expect(rec.props).toMatchObject({ recordType: 'A', values: [expect.stringMatching(/^203\.0\.113\.\d+$/)] });
  });
});

// ---------------------------------------------------------------- dns-01 through the clouds' DNS, and the pushes

describe('dns-01 through Route 53, Azure DNS and DigitalOcean DNS, and renewed certificates on the load balancer (B-10206)', () => {
  let h: Harness;
  let aws: LbAws;
  let az: FakeAzure;
  let dof: LbDo;
  let acme: FakeAcme;
  const accounts: Record<string, CloudAccount> = {};
  const tenantAz = 'tenant-dns';
  const sub = '00000000-0000-4000-8000-0000000000dd';

  beforeAll(async () => {
    aws = await new LbAws().start();
    az = await new FakeAzure().start();
    az.publicOrigin = 'https://management.azure.com';
    az.addSubscription(sub, tenantAz);
    dof = await new LbDo().start();
    acme = await startFakeAcme(async () => null, { resolveTxt: async (name) => aws.txt(name) });
    h = await harness({ SERVICE_ALLOWED_HOSTS: ALLOWED, PLATFORM_ALLOWED_HOSTS: '127.0.0.1', ACME_DIRECTORY_URL: acme.directory, ACME_POLL_MS: '10', ACME_CHALLENGE: 'dns-01', ACME_DNS_WAIT_SECONDS: '0', ACME_DNS_PROVIDER: 'route53', ACME_DNS_CLOUD_ACCOUNT: 'aws-edge' });
    await install(h);
    const key = aws.addUser({ userName: 'exprsn' });
    const app = az.addApp({ tenantId: tenantAz, secret: true });
    const doToken = dof.addToken();
    const registry = new ProviderRegistry({ policy: servicePolicy({ SERVICE_ALLOWED_HOSTS: ALLOWED }), endpoints: { aws: { sts: aws.url, eks: aws.url, iam: aws.url, ec2: aws.url, s3: aws.url, route53: aws.url, rds: aws.url }, digitalocean: { api: dof.url } }, transport: { sleep: async () => undefined, random: () => 0.5, testOrigins: { 'https://management.azure.com': az.url } } });
    Object.defineProperty(h.s.cloud, 'providers', { value: registry, configurable: true });
    (h.s.cloud as { credentials: unknown }).credentials = {
      for: async (a: CloudAccount) => {
        if (a.provider === 'aws') return { kind: 'aws', accessKeyId: key.accessKeyId, secretAccessKey: key.secretAccessKey, expiresAt: null };
        if (a.provider === 'digitalocean') return { kind: 'token', token: doToken, accountId: 'team' };
        return {
          kind: 'azure',
          tenantId: tenantAz,
          getToken: async (scope: string) => {
            const r = await fetch(`${az.url}/${tenantAz}/oauth2/v2.0/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: app.clientId, client_secret: app.secret!, scope }) });
            const j = (await r.json()) as { access_token: string; expires_in: number };
            return { token: j.access_token, expiresAt: Date.now() + j.expires_in * 1000 };
          }
        };
      }
    };
    h.s.cloud.certPush.endpoints = { acm: aws.url, elbv2: aws.url, arm: az.url, digitalocean: dof.url };
    accounts.aws = await seedAccount(h, { provider: 'aws', mode: 'vaulted', name: 'aws-edge', providerIds: { awsAccountId: aws.account }, refs: { accessKeyId: 'vault:cloud/aws-edge#id', secretAccessKey: 'vault:cloud/aws-edge#secret' } });
    accounts.azure = await seedAccount(h, { provider: 'azure', mode: 'vaulted', name: 'az-edge', providerIds: { azureTenantId: tenantAz, azureSubscriptionId: sub }, refs: { clientSecret: 'vault:cloud/az-edge#secret' }, params: { clientId: app.clientId } });
    accounts.digitalocean = await seedAccount(h, { provider: 'digitalocean', mode: 'vaulted', name: 'do-edge', providerIds: { doTeamId: 'team' }, refs: { token: 'vault:cloud/do-edge#token' } });
    aws.addZone('example.test');
    // Azure DNS: the zone in the account's managed resource group.
    const rg = `/subscriptions/${sub}/resourcegroups/exprsn-az-edge`;
    az.resources.set(rg, { id: `/subscriptions/${sub}/resourceGroups/exprsn-az-edge`, name: 'exprsn-az-edge', type: 'Microsoft.Resources/resourceGroups', location: 'westeurope', etag: 'x', body: { location: 'westeurope' } });
    az.resources.set(`${rg}/providers/microsoft.network/dnszones/example.test`, { id: `/subscriptions/${sub}/resourceGroups/exprsn-az-edge/providers/Microsoft.Network/dnsZones/example.test`, name: 'example.test', type: 'Microsoft.Network/dnsZones', etag: 'x', body: {} });
    dof.domains.set('example.test', [{ id: 1, type: 'NS', name: '@', data: 'ns1.digitalocean.com', ttl: 1800, priority: null, port: null, weight: null, flags: null, tag: null }] as never);
  });
  afterAll(async () => {
    await h.close();
    await acme.close();
    await aws.stop();
    await az.stop();
    await dof.stop();
  });

  it('publishes and removes the TXT record on each provider\'s fake, a wildcard and its base name sharing one set', async () => {
    const providers = {
      route53: new CloudDnsProvider(() => h.s, 'route53', 'aws-edge', null, { sleep: async () => undefined }),
      'azure-dns': new CloudDnsProvider(() => h.s, 'azure-dns', accounts.azure!.id, 'example.test', { sleep: async () => undefined }),
      digitalocean: new CloudDnsProvider(() => h.s, 'digitalocean', 'do-edge', 'example.test, other.test', { sleep: async () => undefined })
    };
    const azTxt = () => [...az.resources.values()].filter((x) => x.type === 'Microsoft.Network/dnszones/TXT').map((x) => JSON.stringify(x.body));
    const doTxt = () => ((dof.domains.get('example.test') ?? []) as { type: string; name: string; data: string }[]).filter((x) => x.type === 'TXT' && x.name === '_acme-challenge.www').map((x) => x.data.replace(/^"|"$/g, ''));
    const v1 = randomBytes(32).toString('base64url');
    const v2 = randomBytes(32).toString('base64url');
    for (const [kind, p] of Object.entries(providers)) {
      await p.present('*.www.example.test', v1);
      await p.present('www.example.test', v2);
      await p.present('www.example.test', v2); // twice: no second value
      if (kind === 'route53') expect(aws.txt('_acme-challenge.www.example.test').sort()).toEqual([v1, v2].sort());
      if (kind === 'azure-dns') {
        expect(azTxt().join(' ')).toContain(v1);
        expect(azTxt().join(' ')).toContain(v2);
        expect(azTxt()).toHaveLength(1);
      }
      if (kind === 'digitalocean') expect(doTxt().sort()).toEqual([v1, v2].sort());
      await p.cleanup('*.www.example.test', v1);
      if (kind === 'route53') expect(aws.txt('_acme-challenge.www.example.test')).toEqual([v2]);
      if (kind === 'digitalocean') expect(doTxt()).toEqual([v2]);
      await p.cleanup('www.example.test', v2);
      if (kind === 'route53') expect(aws.txt('_acme-challenge.www.example.test')).toEqual([]);
      if (kind === 'azure-dns') expect(azTxt()).toHaveLength(0);
      if (kind === 'digitalocean') expect(doTxt()).toEqual([]);
    }
    // Route 53 changes were followed to INSYNC before present returned.
    expect(aws.calls('route53:GetChange').length).toBeGreaterThan(0);
    // A name outside the zones, the wrong provider's account, a missing account: refused with the reason.
    await expect(providers.digitalocean.present('www.elsewhere.test', v1)).rejects.toThrow(/not inside example\.test, other\.test/);
    await expect(new CloudDnsProvider(() => h.s, 'route53', 'do-edge').present('www.example.test', v1)).rejects.toThrow(/needs a aws account/);
    await expect(new CloudDnsProvider(() => h.s, 'route53', 'nobody').present('www.example.test', v1)).rejects.toThrow(/names no cloud account/);
    await expect(new CloudDnsProvider(() => h.s, 'route53', 'aws-edge').present('www.unhosted.test', v1)).rejects.toThrow(/No Route 53 zone/);
  });

  it('the settings: ACME_DNS_PROVIDER=route53 gives a cloud DNS provider; azure-dns and digitalocean need the zone', async () => {
    expect(h.s.ops.certs.dns?.name).toBe('Route 53 through the cloud account aws-edge');
    const { parseConfigWith } = await import('../src/config/index.js');
    const errors = (o: Record<string, string>) => {
      const r = parseConfigWith({}, { SESSION_SECRET: 'a'.repeat(64), DATA_KEY: Buffer.alloc(32, 7).toString('base64'), ACME_CHALLENGE: 'dns-01', ...o });
      return r.ok ? '' : r.errors.join('\n');
    };
    expect(errors({ ACME_DNS_PROVIDER: 'route53' })).toMatch(/ACME_DNS_CLOUD_ACCOUNT/);
    expect(errors({ ACME_DNS_PROVIDER: 'route53', ACME_DNS_CLOUD_ACCOUNT: 'aws-edge' })).not.toMatch(/ACME_DNS_CLOUD/);
    expect(errors({ ACME_DNS_PROVIDER: 'digitalocean', ACME_DNS_CLOUD_ACCOUNT: 'do-edge' })).toMatch(/ACME_DNS_CLOUD_ZONE/);
    expect(errors({ ACME_DNS_PROVIDER: 'azure-dns', ACME_DNS_CLOUD_ACCOUNT: 'az-edge', ACME_DNS_CLOUD_ZONE: 'example.test,other.test' })).not.toMatch(/ACME_DNS_CLOUD/);
  });

  it('a certificate renewed by dns-01 on Route 53 is served by the load balancer before the old one expires', async () => {
    await localUser(h, 'root', ['system-admin'], 'restricted');
    const a = await loginAdmin(h, 'root');
    const post = (u: string, body: object = {}) => a.agent.post(u).set('x-csrf-token', a.csrf).send(body);
    const { listenerArn, lbArn } = aws.addListener('edge');
    acme.validityDays = 20; // inside ACME_RENEW_DAYS (30): the sweep renews it
    const req = await post('/api/admin/platform/certificates', { domains: ['app.example.test'], use: 'TLS', autoRenew: true }).expect(202);
    const certId = req.body.id as string;
    // The push hook: by load balancer ARN (the HTTPS listener is found on port 443).
    const hook = await post(`/api/admin/platform/certificates/${certId}/hooks`, { kind: 'aws-acm', accountId: accounts.aws!.id, target: { loadBalancerArn: lbArn } }).expect(201);
    expect(hook.body).toMatchObject({ kind: 'aws-acm', accountId: accounts.aws!.id, target: { loadBalancerArn: lbArn, port: 443 } });
    await post(`/api/admin/platform/certificates/${certId}/hooks`, { kind: 'aws-acm', accountId: accounts.digitalocean!.id, target: { loadBalancerArn: lbArn } }).expect(400);
    await post(`/api/admin/platform/certificates/${certId}/hooks`, { kind: 'aws-acm', accountId: accounts.aws!.id, target: {} }).expect(400);
    await h.s.jobs.runDue();
    const first = (await a.agent.get('/api/admin/platform/certificates').expect(200)).body.find((c: { id: string }) => c.id === certId);
    expect(first).toMatchObject({ status: 'expiring', domains: ['app.example.test'] });
    const served1 = aws.served(listenerArn)!;
    expect(served1.serialNumber).toBe(first.serial);
    expect(aws.txt('_acme-challenge.app.example.test')).toEqual([]); // the client cleaned up
    const certArn = [...aws.certificates.keys()][0]!;
    const oldNotAfter = Date.parse(served1.validTo);

    // The renewal sweep: due inside the window, renewed by dns-01 on Route 53, pushed by the hook.
    acme.validityDays = 90;
    const by = { tenantId: h.tenantId, userId: null, actor: { service: 'test' } };
    expect((await h.s.ops.certs.sweep(by)).renewing).toEqual(['app.example.test']);
    await h.s.jobs.runDue();
    const renewed = (await h.s.ops.certs.get(certId));
    expect(renewed.serial).not.toBe(first.serial);
    const served2 = aws.served(listenerArn)!;
    expect(served2.serialNumber).toBe(renewed.serial);
    expect(Date.now()).toBeLessThan(oldNotAfter);
    expect(Date.parse(served2.validTo)).toBeGreaterThan(oldNotAfter);
    // Re-imported into the same ARN, which the listener already served: one certificate, two imports.
    expect(aws.certificates.size).toBe(1);
    expect(aws.certificates.get(certArn)!.imports).toBe(2);
    expect(aws.calls('elasticloadbalancing:ModifyListener')).toHaveLength(1);
    const hooks = (await a.agent.get(`/api/admin/platform/certificates/${certId}/hooks`).expect(200)).body.hooks as { lastState: string; lastDetail: string; target: { state: Record<string, string> } }[];
    expect(hooks[0]).toMatchObject({ lastState: 'ok', lastDetail: expect.stringMatching(/re-imported/), target: { state: { certificateArn: certArn, listenerArn, serial: renewed.serial } } });
    expect((await h.s.audit.list(h.tenantId, { action: 'platform.cert.hook.ran' })).length).toBe(2);
    // The key travelled only to ACM (inside the signed call), never into the hook's row or an audit entry.
    expect(JSON.stringify(await h.s.db('platform_cert_hooks').select())).not.toMatch(/PRIVATE KEY/);
    expect(JSON.stringify(await h.s.db('audit_events').select('detail'))).not.toMatch(/PRIVATE KEY/);
  });

  it('pushes to an Azure Application Gateway (a PKCS#12 by ARM PUT) and a DigitalOcean load balancer', async () => {
    // Azure: the gateway with an HTTPS listener.
    const gw = `/subscriptions/${sub}/resourcegroups/exprsn-az-edge/providers/microsoft.network/applicationgateways/edge-gw`;
    az.resources.set(gw, { id: `/subscriptions/${sub}/resourceGroups/exprsn-az-edge/providers/Microsoft.Network/applicationGateways/edge-gw`, name: 'edge-gw', type: 'Microsoft.Network/applicationGateways', location: 'westeurope', etag: 'x', body: { location: 'westeurope', properties: { sslCertificates: [{ name: 'old', properties: { data: 'b2xk', password: 'x' } }], httpListeners: [{ name: 'https', properties: { protocol: 'Https' } }] } } });
    const c = certFor('gw.example.test');
    const out = await h.s.cloud.certPush.push('azure-appgw', accounts.azure!.id, { resourceGroup: 'exprsn-az-edge', gateway: 'edge-gw', listener: 'https' }, { id: 'c1', name: 'gw.example.test', ...c });
    expect(out).toMatchObject({ state: { gateway: 'edge-gw', certificateName: 'exprsn-gw-example-test', serial: c.serial } });
    const props = (az.resources.get(gw)!.body as { properties: { sslCertificates: { name: string; properties: { data: string; password: string } }[]; httpListeners: { name: string; properties: { sslCertificate?: { id: string } } }[] } }).properties;
    const ssl = props.sslCertificates.find((x) => x.name === 'exprsn-gw-example-test')!;
    expect(Buffer.from(ssl.properties.data, 'base64')[0]).toBe(0x30); // a DER PFX
    expect(ssl.properties.password.length).toBeGreaterThan(20);
    expect(props.sslCertificates.map((x) => x.name)).toEqual(['old', 'exprsn-gw-example-test']);
    expect(props.httpListeners[0]!.properties.sslCertificate!.id).toMatch(/applicationGateways\/edge-gw\/sslCertificates\/exprsn-gw-example-test$/);

    // DigitalOcean: a custom certificate on the HTTPS forwarding rule; the replaced one deleted.
    const lbId = dof.addLb();
    const c1 = certFor('do.example.test');
    const o1 = await h.s.cloud.certPush.push('do-lb', accounts.digitalocean!.id, { loadBalancerId: lbId }, { id: 'c2', name: 'do.example.test', ...c1 });
    const lb = dof.lbs.get(lbId)!;
    expect(lb.forwarding_rules[0]).toMatchObject({ entry_protocol: 'https', certificate_id: o1.state.certificateId });
    expect(lb.forwarding_rules[1]!.certificate_id).toBe('');
    const c2 = certFor('do.example.test', 90);
    const o2 = await h.s.cloud.certPush.push('do-lb', accounts.digitalocean!.id, { loadBalancerId: lbId, state: o1.state }, { id: 'c2', name: 'do.example.test', ...c2 });
    expect(lb.forwarding_rules[0]!.certificate_id).toBe(o2.state.certificateId);
    expect(new X509Certificate(dof.certificates.get(o2.state.certificateId!)!.leaf).serialNumber).toBe(c2.serial);
    expect(dof.certificates.has(o1.state.certificateId!)).toBe(false);
    expect(o2.detail).toMatch(/1 replaced certificate deleted/);
  });

  it('parses ELBv2 listeners whose certificates and actions nest members', () => {
    const xml = '<Listeners><member><Certificates><member><CertificateArn>c</CertificateArn></member></Certificates><Port>443</Port><Protocol>HTTPS</Protocol><ListenerArn>l1</ListenerArn></member><member><Port>80</Port><ListenerArn>l2</ListenerArn></member></Listeners>';
    expect(listenerMembers(xml)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------- the Exprsn-AI CA

describe('the Exprsn-AI CA instead of a public one: dns-01 on Route 53, the certificate on the load balancer (B-10206)', () => {
  let f: Awaited<ReturnType<typeof signerFixture>>;
  let dns: FakeDns;
  let h: Harness;
  let aws: LbAws;
  let interPem: string;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** Two job loops, so the platform's issuing job can wait while another loop runs the CA's validation jobs. */
  const runJobs = () => {
    let on = true;
    const loop = async () => {
      while (on) {
        await h.s.jobs.runDue(5).catch(() => undefined);
        await sleep(15);
      }
    };
    const loops = [loop(), loop()];
    return async () => {
      on = false;
      await Promise.all(loops);
    };
  };
  const waitValid = async (id: string, serialNot?: string | null) => {
    const end = Date.now() + 45_000;
    for (;;) {
      const r = (await h.s.db('platform_certificates').where({ id }).first()) as Record<string, unknown>;
      if (r.state === 'failed') throw new Error(`issue failed: ${String(r.error)}`);
      if (r.state === 'valid' && r.serial && r.serial !== serialNot) return r;
      if (Date.now() > end) throw new Error('timed out');
      await sleep(25);
    }
  };

  beforeAll(async () => {
    f = await signerFixture();
    dns = await startFakeDns();
    aws = await new LbAws().start();
    h = await harness({ ...f.env, SERVICE_ALLOWED_HOSTS: ALLOWED, PKI_ACME_DNS_SERVERS: dns.address, ACME_POLL_MS: '20', ACME_DNS_WAIT_SECONDS: '0', PKI_EXPIRY_SWEEP_MINUTES: '0', ACME_CHALLENGE: 'dns-01', ACME_DNS_PROVIDER: 'route53', ACME_DNS_CLOUD_ACCOUNT: 'aws-ca' });
    await install(h);
    const port = (loopbackServerFor(h.app)!.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    h.s.cfg.PKI_PUBLIC_URL = base;
    const slug = (await h.s.tenants.byId(h.tenantId))!.slug;
    const directory = `${base}/pki/acme/${slug}/directory`;
    await localUser(h, 'ta', ['tenant-admin'], 'confidential');
    const ta = await loginAdmin(h, 'ta');
    const by = { tenantId: h.tenantId, userId: null, actor: { service: 'test' } };
    await h.s.pki.createRoot(by, { commonName: 'Cloud TLS Test Root', keyType: 'ecdsa-p256', days: 3650 });
    interPem = (await h.s.pki.createIntermediate(by, h.tenantId, { keyType: 'ecdsa-p256', days: 1825 })).certificate_pem;
    const p = await ta.agent.post('/api/pki/profiles').set('x-csrf-token', ta.csrf).send({ name: 'acme', kind: 'server', maxDays: 90, defaultDays: 30, policy: { domains: ['*.acme.test'], allowWildcard: true } });
    expect(p.status).toBe(201);
    expect((await ta.agent.put('/api/pki/acme').set('x-csrf-token', ta.csrf).send({ enabled: true, profileId: p.body.id })).status).toBe(200);
    (h.s as { acme: unknown }).acme = new HttpAcmeClient(directory, { pollMs: 20 });
    // Route 53 (the fake) is the authority the CA's resolver asks: every change is mirrored into the DNS server.
    aws.addZone('acme.test');
    aws.onRoute53Change = () => {
      dns.txt.clear();
      for (const z of aws.zones.values()) for (const set of z.Records.values()) if (set.Type === 'TXT') dns.txt.set(set.Name.replace(/\.$/, ''), set.Values.map((v) => v.replace(/^"|"$/g, '')));
    };
    const key = aws.addUser({ userName: 'exprsn' });
    const registry = new ProviderRegistry({ policy: servicePolicy({ SERVICE_ALLOWED_HOSTS: ALLOWED }), endpoints: { aws: { sts: aws.url, eks: aws.url, iam: aws.url, ec2: aws.url, s3: aws.url, route53: aws.url, rds: aws.url } }, transport: { sleep: async () => undefined, random: () => 0.5 } });
    Object.defineProperty(h.s.cloud, 'providers', { value: registry, configurable: true });
    (h.s.cloud as { credentials: unknown }).credentials = { for: async () => ({ kind: 'aws', accessKeyId: key.accessKeyId, secretAccessKey: key.secretAccessKey, expiresAt: null }) };
    h.s.cloud.certPush.endpoints = { acm: aws.url, elbv2: aws.url };
    await seedAccount(h, { provider: 'aws', mode: 'vaulted', name: 'aws-ca', providerIds: { awsAccountId: aws.account }, refs: { accessKeyId: 'vault:cloud/aws-ca#id', secretAccessKey: 'vault:cloud/aws-ca#secret' } });
  }, 120_000);
  afterAll(async () => {
    await h.close();
    await aws.stop();
    await dns.close();
    await f.close();
  });

  it('issues from the tenant\'s own CA by dns-01 through Route 53, pushes it to the listener, and pushes the renewal too', async () => {
    const { listenerArn } = aws.addListener('internal-edge');
    const account = (await h.s.cloud.accounts.list(null)).find((a) => a.name === 'aws-ca')!;
    await localUser(h, 'root', ['system-admin'], 'restricted');
    const a = await loginAdmin(h, 'root');
    const post = (u: string, body: object = {}) => a.agent.post(u).set('x-csrf-token', a.csrf).send(body);
    const req = await post('/api/admin/platform/certificates', { domains: ['*.acme.test', 'lb.acme.test'], use: 'TLS' }).expect(202);
    await post(`/api/admin/platform/certificates/${req.body.id}/hooks`, { kind: 'aws-acm', accountId: account.id, target: { listenerArn } }).expect(201);
    const stop = runJobs();
    let row: Record<string, unknown>;
    try {
      row = await waitValid(req.body.id);
    } finally {
      await stop();
    }
    const blocks = String(row.chain_pem).match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)!;
    const leaf = new X509Certificate(blocks[0]!);
    expect(leaf.verify(new X509Certificate(interPem).publicKey)).toBe(true);
    expect(leaf.subjectAltName).toBe('DNS:*.acme.test, DNS:lb.acme.test');
    // The CA asked its resolver for the challenge records, which Route 53 (the fake) held; the client removed them after.
    expect(dns.queries).toEqual(expect.arrayContaining(['_acme-challenge.acme.test/16', '_acme-challenge.lb.acme.test/16']));
    expect(aws.txt('_acme-challenge.acme.test')).toEqual([]);
    expect(aws.served(listenerArn)!.serialNumber).toBe(leaf.serialNumber);
    // A renewal from the same CA reaches the listener as well.
    await post(`/api/admin/platform/certificates/${req.body.id}/renew`).expect(202);
    const stop2 = runJobs();
    let renewed: Record<string, unknown>;
    try {
      renewed = await waitValid(req.body.id, String(row.serial));
    } finally {
      await stop2();
    }
    expect(aws.served(listenerArn)!.serialNumber).toBe(String(renewed.serial));
  }, 90_000);
});
