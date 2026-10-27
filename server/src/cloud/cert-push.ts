import { createHash, createPrivateKey, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { pemBlocks } from '../ops/der.js';
import { signV4 } from '../platform/blob.js';
import { servicePolicy } from '../platform/egress.js';
import { buildPkcs12 } from '../pki/pkcs12.js';
import type { Services } from '../services.js';
import { xmlText } from './credential-http.js';
import { CloudTransport, type TransportOptions } from './providers/transport.js';
import { CloudProviderError } from './providers/types.js';
import type { CloudAccount, Provider } from './types.js';

/*
 * 1.9.99-final, Sprint 58 (B-10206): a renewed certificate pushed to a cloud load balancer, as certificate push hooks
 * (B-1806, `ops/cert-hooks.ts`) of three new kinds. Each runs on the issuing instance after every issue and renewal,
 * so the load balancer serves the new certificate as soon as it exists, long before the old one expires (the ACME
 * renewal window, ACME_RENEW_DAYS, is the margin).
 *
 *   aws-acm      ACM `ImportCertificate` (re-imported into the same ARN after the first push, which every listener
 *                using that ARN picks up), then ELBv2 `ModifyListener` when the HTTPS listener still names another
 *                certificate
 *   azure-appgw  the Application Gateway's SSL certificate (a PKCS#12 with a one-time password, never stored) replaced
 *                by an ARM PUT of the gateway, followed until the operation succeeds
 *   do-lb        a DigitalOcean custom certificate uploaded, the load balancer's HTTPS forwarding rules pointed at it,
 *                and the certificate it replaced deleted
 *
 * Every call goes through `CloudTransport` (the egress guard, the rate limiter, the breaker) with the account's
 * `deploy` credential. The target names the load balancer directly or as a deployment's resource
 * (`{ deploymentId, resourceKey }`, resolved from the resource graph at push time). The private key is opened from
 * its seal only for the push and never written anywhere else; the hook's target keeps what the last push left (the
 * ACM ARN, the DigitalOcean certificate id, the serial).
 */

export const CLOUD_PUSH_KINDS = ['aws-acm', 'azure-appgw', 'do-lb'] as const;
export type CloudPushKind = (typeof CLOUD_PUSH_KINDS)[number];
export const isCloudPushKind = (k: string): k is CloudPushKind => (CLOUD_PUSH_KINDS as readonly string[]).includes(k);
export const PUSH_PROVIDER: Record<CloudPushKind, Provider> = { 'aws-acm': 'aws', 'azure-appgw': 'azure', 'do-lb': 'digitalocean' };

const arn = z.string().regex(/^arn:aws[a-z-]*:elasticloadbalancing:[a-z0-9-]+:\d{12}:(listener|loadbalancer)\/[A-Za-z0-9/._-]+$/, 'an ELBv2 listener or load balancer ARN');
const deploymentRef = { deploymentId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/).optional(), resourceKey: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/).optional() };
const azName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._()-]{0,79}$/);

export const pushTargetSchemas = {
  'aws-acm': z.object({ region: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/).optional(), listenerArn: arn.optional(), loadBalancerArn: arn.optional(), port: z.number().int().min(1).max(65535).default(443), ...deploymentRef }).strict(),
  'azure-appgw': z.object({ resourceGroup: azName.optional(), gateway: azName.optional(), certificateName: azName.optional(), listener: azName.optional(), ...deploymentRef }).strict(),
  'do-lb': z.object({ loadBalancerId: z.string().regex(/^[0-9a-f-]{36}$/).optional(), ...deploymentRef }).strict()
} as const;

export type PushTarget = Record<string, unknown> & { deploymentId?: string; resourceKey?: string; state?: Record<string, string> };

/** Endpoints for the tests' fakes; the real ones are derived from the region. */
export interface PushEndpoints {
  acm?: string;
  elbv2?: string;
  arm?: string;
  digitalocean?: string;
}

export interface PushCert {
  id: string;
  name: string;
  serial: string | null;
  chainPem: string;
  keyPem: string;
}

const sha256 = (b: string) => createHash('sha256').update(b).digest('hex');
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

/** The listeners of an ELBv2 `DescribeListeners` answer: the top-level members of `<Listeners>` (members nest). */
export function listenerMembers(xml: string): string[] {
  const block = /<Listeners>([\s\S]*)<\/Listeners>/.exec(xml)?.[1] ?? '';
  const out: string[] = [];
  const re = /<(\/?)member>/g;
  let depth = 0;
  let start = -1;
  for (let m = re.exec(block); m; m = re.exec(block)) {
    if (!m[1]) {
      if (depth === 0) start = m.index + m[0].length;
      depth++;
    } else {
      depth--;
      if (depth === 0 && start >= 0) out.push(block.slice(start, m.index));
    }
  }
  return out;
}

/** An element's text at the top level of a member (not inside a nested member). */
function topText(member: string, tag: string): string | null {
  return xmlText(member.replace(/<member>[\s\S]*?<\/member>/g, ''), tag);
}

export function splitChain(chainPem: string): { leaf: string; chain: string } {
  const blocks = chainPem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  if (!blocks.length) throw new Error('The certificate has no PEM chain to push.');
  return { leaf: `${blocks[0]!}\n`, chain: blocks.slice(1).join('\n') + (blocks.length > 1 ? '\n' : '') };
}

export class CloudCertPush {
  endpoints: PushEndpoints = {};
  /** Tests: options for the transports (sleep, test origins). */
  transportOptions: Partial<Omit<TransportOptions, 'provider' | 'policy' | 'counters'>> = {};
  private readonly transports = new Map<Provider, CloudTransport>();
  /** Polls of an Azure operation before the push fails. */
  maxPolls = 60;
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));

  constructor(private readonly s: () => Services) {}

  private transport(provider: Provider): CloudTransport {
    let t = this.transports.get(provider);
    if (!t) {
      const s = this.s();
      t = new CloudTransport({ provider, policy: servicePolicy(s.cfg), counters: s.counters, timeoutMs: s.cfg.CLOUD_HTTP_TIMEOUT_MS, ...this.transportOptions });
      this.transports.set(provider, t);
    }
    return t;
  }

  /** Checks a hook's target when it is added: its shape, and the account (visible, active, the provider the kind needs). */
  async checkTarget(kind: CloudPushKind, accountId: string, raw: unknown): Promise<{ account: CloudAccount; target: PushTarget }> {
    const r = pushTargetSchemas[kind].safeParse(raw ?? {});
    if (!r.success) throw new Error(`The target does not validate: ${r.error.issues.map((i) => `${i.path.join('.') || 'target'}: ${i.message}`).join('; ')}`);
    const t = r.data as PushTarget;
    const direct = kind === 'aws-acm' ? !!(t.listenerArn || t.loadBalancerArn) : kind === 'azure-appgw' ? !!(t.resourceGroup && t.gateway) : !!t.loadBalancerId;
    if (!direct && !(t.deploymentId && t.resourceKey)) throw new Error(kind === 'aws-acm' ? 'Name the listener or load balancer ARN, or a deployment and its resource key.' : kind === 'azure-appgw' ? 'Name the resource group and the gateway, or a deployment and its resource key.' : 'Name the load balancer id, or a deployment and its resource key.');
    const account = await this.s().cloud.accounts.get(accountId);
    if (!account) throw new Error('No such cloud account.');
    if (account.provider !== PUSH_PROVIDER[kind]) throw new Error(`${account.name} is a ${account.provider} account; ${kind} needs a ${PUSH_PROVIDER[kind]} account.`);
    if (account.state === 'pending' || account.state === 'disabled') throw new Error(`${account.name} is ${account.state}.`);
    return { account, target: t };
  }

  /** A deployment resource's provider id (and its region), for targets named through the resource graph. */
  private async fromGraph(t: PushTarget, accountId: string): Promise<{ providerId: string; region: string | null }> {
    const d = await this.s().cloud.deployments.get(String(t.deploymentId));
    if (!d || d.accountId !== accountId) throw new Error('The deployment the target names is not on this account.');
    const r = await this.s().cloud.deployments.resource(d.id, String(t.resourceKey));
    if (!r?.providerId) throw new Error(`${d.name} has no ${String(t.resourceKey)} with a provider id yet.`);
    return { providerId: r.providerId, region: r.region ?? d.region };
  }

  /** Pushes one issued certificate to the hook's load balancer; returns what it did and the target's new state. */
  async push(kind: CloudPushKind, accountId: string, target: PushTarget, cert: PushCert): Promise<{ detail: string; state: Record<string, string> }> {
    const s = this.s();
    const account = await s.cloud.accounts.get(accountId);
    if (!account) throw new Error('The hook\'s cloud account no longer exists.');
    if (account.state === 'pending' || account.state === 'disabled') throw new Error(`${account.name} is ${account.state}; nothing is pushed.`);
    if (!s.cloud.credentials) throw new Error('Cloud credentials are not available on this server.');
    const cred = (await s.cloud.credentials.for(account, 'deploy')) as Record<string, unknown>;
    if (kind === 'aws-acm') return this.pushAws(account, cred, target, cert);
    if (kind === 'azure-appgw') return this.pushAzure(account, cred, target, cert);
    return this.pushDo(account, cred, target, cert);
  }

  // ---------- AWS: ACM and ELBv2 ----------

  private async awsCall(account: CloudAccount, keys: Record<string, unknown>, o: { service: 'acm' | 'elasticloadbalancing'; region: string; body: string; target?: string }): Promise<string> {
    const base = o.service === 'acm' ? (this.endpoints.acm ?? `https://acm.${o.region}.amazonaws.com`) : (this.endpoints.elbv2 ?? `https://elasticloadbalancing.${o.region}.amazonaws.com`);
    const url = new URL('/', base);
    const headers: Record<string, string> = o.target ? { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': o.target } : { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' };
    if (keys.sessionToken) headers['x-amz-security-token'] = String(keys.sessionToken);
    if (!keys.accessKeyId || !keys.secretAccessKey) throw new CloudProviderError(`${account.name}'s credential is not an AWS key.`, 'aws', 400, 'wrong_credential');
    const signed = signV4({ method: 'POST', url, headers, payloadHash: sha256(o.body), region: o.region, service: o.service, accessKeyId: String(keys.accessKeyId), secretAccessKey: String(keys.secretAccessKey), date: new Date() });
    const res = await this.transport('aws').send({ method: 'POST', url, headers: signed, body: o.body, accountId: account.id, apiClass: 'mutate' });
    const text = res.body.toString('utf8');
    if (res.status >= 200 && res.status < 300) return text;
    let code: string | null = xmlText(text, 'Code');
    let message: string | null = xmlText(text, 'Message');
    try {
      const j = JSON.parse(text) as { __type?: string; message?: string };
      code = j.__type?.split('#').pop() ?? code;
      message = j.message ?? message;
    } catch {
      /* XML */
    }
    throw new CloudProviderError(`AWS ${o.service === 'acm' ? 'ACM' : 'ELBv2'} answered ${res.status}${code ? ` (${code})` : ''}${message ? `: ${message.slice(0, 200)}` : ''}`, 'aws', res.status, code, res.requestId);
  }

  private async pushAws(account: CloudAccount, keys: Record<string, unknown>, t: PushTarget, cert: PushCert) {
    let lbArn = (t.loadBalancerArn as string | undefined) ?? null;
    let listenerArn = (t.listenerArn as string | undefined) ?? null;
    let region = (t.region as string | undefined) ?? null;
    if (!lbArn && !listenerArn) {
      const g = await this.fromGraph(t, account.id);
      if (g.providerId.includes(':listener/')) listenerArn = g.providerId;
      else lbArn = g.providerId;
      region ??= g.region;
    }
    region ??= /^arn:aws[a-z-]*:elasticloadbalancing:([a-z0-9-]+):/.exec(listenerArn ?? lbArn ?? '')?.[1] ?? account.defaultRegion ?? 'us-east-1';
    const { leaf, chain } = splitChain(cert.chainPem);
    const prior = t.state?.certificateArn ?? null;
    const body: Record<string, unknown> = { Certificate: b64(leaf), PrivateKey: b64(cert.keyPem), ...(chain ? { CertificateChain: b64(chain) } : {}) };
    if (prior) body.CertificateArn = prior;
    else body.Tags = [{ Key: 'exprsn:managed', Value: 'true' }, { Key: 'exprsn:account', Value: account.name }, { Key: 'exprsn:certificate', Value: cert.name.replace(/[^A-Za-z0-9 _.:/=+@-]/g, '_').slice(0, 256) }];
    const imported = JSON.parse(await this.awsCall(account, keys, { service: 'acm', region, target: 'CertificateManager.ImportCertificate', body: JSON.stringify(body) })) as { CertificateArn?: string };
    const certArn = imported.CertificateArn ?? prior;
    if (!certArn) throw new Error('ACM answered without a certificate ARN.');
    // The HTTPS listener: the one named, or the load balancer's listener on the target's port.
    if (!listenerArn) {
      const xml = await this.awsCall(account, keys, { service: 'elasticloadbalancing', region, body: new URLSearchParams({ Action: 'DescribeListeners', Version: '2015-12-01', LoadBalancerArn: lbArn! }).toString() });
      const port = String(t.port ?? 443);
      const m = listenerMembers(xml).find((x) => topText(x, 'Port') === port && /HTTPS|TLS/.test(topText(x, 'Protocol') ?? ''));
      listenerArn = m ? topText(m, 'ListenerArn') : null;
      if (!listenerArn) throw new Error(`The load balancer has no HTTPS or TLS listener on port ${port}.`);
    }
    let moved = false;
    const desc = await this.awsCall(account, keys, { service: 'elasticloadbalancing', region, body: new URLSearchParams({ Action: 'DescribeListeners', Version: '2015-12-01', 'ListenerArns.member.1': listenerArn }).toString() });
    const current = xmlText(xmlText(desc, 'Certificates') ?? '', 'CertificateArn');
    if (current !== certArn) {
      await this.awsCall(account, keys, { service: 'elasticloadbalancing', region, body: new URLSearchParams({ Action: 'ModifyListener', Version: '2015-12-01', ListenerArn: listenerArn, 'Certificates.member.1.CertificateArn': certArn }).toString() });
      moved = true;
    }
    return { detail: `ACM ${prior ? 're-imported' : 'imported'} ${certArn}${moved ? `; listener ${listenerArn} now serves it` : '; the listener already serves that ARN'}`, state: { certificateArn: certArn, listenerArn, region, serial: cert.serial ?? '' } };
  }

  // ---------- Azure: Application Gateway ----------

  private async arm<T>(account: CloudAccount, cred: Record<string, unknown>, method: string, path: string, body?: unknown): Promise<{ status: number; body: T; headers: Record<string, string> }> {
    const getToken = cred.getToken as ((scope: string) => Promise<{ token: string }>) | undefined;
    if (!getToken) throw new CloudProviderError(`${account.name}'s credential is not an Azure one.`, 'azure', 400, 'wrong_credential');
    const { token } = await getToken('https://management.azure.com/.default');
    const url = new URL(path, this.endpoints.arm ?? 'https://management.azure.com');
    const res = await this.transport('azure').json<T>({ method, url, headers: { authorization: `Bearer ${token}` }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), accountId: account.id }, (status, b) => {
      const e = (b as { error?: { code?: string; message?: string } } | null)?.error;
      return { message: `Azure answered ${status}${e?.code ? ` (${e.code})` : ''}${e?.message ? `: ${e.message.slice(0, 200)}` : ''}`, code: e?.code ?? null };
    });
    return res;
  }

  private async pushAzure(account: CloudAccount, cred: Record<string, unknown>, t: PushTarget, cert: PushCert) {
    let group = (t.resourceGroup as string | undefined) ?? null;
    let gateway = (t.gateway as string | undefined) ?? null;
    let sub = account.providerIds.azureSubscriptionId ?? null;
    if (!group || !gateway) {
      const g = await this.fromGraph(t, account.id);
      const m = /\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.Network\/applicationGateways\/([^/]+)/i.exec(g.providerId);
      if (!m) throw new Error(`${String(t.resourceKey)} is not an Application Gateway (${g.providerId}).`);
      [sub, group, gateway] = [m[1]!, m[2]!, m[3]!];
    }
    if (!sub) throw new Error(`${account.name} names no Azure subscription.`);
    const path = `/subscriptions/${encodeURIComponent(sub)}/resourceGroups/${encodeURIComponent(group)}/providers/Microsoft.Network/applicationGateways/${encodeURIComponent(gateway)}`;
    const api = 'api-version=2023-09-01';
    const gw = (await this.arm<Record<string, unknown>>(account, cred, 'GET', `${path}?${api}`)).body as { location?: string; tags?: Record<string, string>; properties?: Record<string, unknown> };
    const props = { ...(gw.properties ?? {}) } as Record<string, unknown> & { sslCertificates?: { name: string; properties?: Record<string, unknown> }[]; httpListeners?: { name: string; properties?: Record<string, unknown> }[] };
    const name = (t.certificateName as string | undefined) ?? `exprsn-${cert.name.replace(/[^A-Za-z0-9-]/g, '-').slice(0, 60)}`;
    const password = randomBytes(24).toString('base64url');
    const ders = pemBlocks(cert.chainPem);
    const pfx = buildPkcs12({ certificates: ders, privateKey: createPrivateKey(cert.keyPem), password, friendlyName: cert.name.slice(0, 60) });
    const certs = [...(props.sslCertificates ?? [])].filter((c) => c.name !== name);
    certs.push({ name, properties: { data: pfx.toString('base64'), password } });
    props.sslCertificates = certs;
    const certRef = `${path}/sslCertificates/${name}`;
    if (t.listener) {
      props.httpListeners = (props.httpListeners ?? []).map((l) => (l.name === t.listener ? { ...l, properties: { ...(l.properties ?? {}), sslCertificate: { id: certRef } } } : l));
    }
    const put = await this.arm<Record<string, unknown>>(account, cred, 'PUT', `${path}?${api}`, { location: gw.location, ...(gw.tags ? { tags: gw.tags } : {}), properties: props });
    const op = put.headers['azure-asyncoperation'];
    if (op) {
      const opUrl = new URL(op);
      const armOrigin = new URL(this.endpoints.arm ?? 'https://management.azure.com').origin;
      if (opUrl.origin !== armOrigin && opUrl.origin !== 'https://management.azure.com') throw new Error('The operation URL is not on the ARM endpoint.');
      for (let i = 0; ; i++) {
        const st = (await this.arm<{ status?: string; error?: { message?: string } }>(account, cred, 'GET', `${opUrl.pathname}${opUrl.search}`)).body;
        if (st.status === 'Succeeded') break;
        if (st.status === 'Failed' || st.status === 'Canceled') throw new Error(`The gateway update ${st.status.toLowerCase()}: ${st.error?.message ?? 'no detail'}`);
        if (i >= this.maxPolls) throw new Error('The gateway update did not finish in time.');
        await this.sleep(2000);
      }
    }
    return { detail: `Application Gateway ${gateway} serves ${name}${t.listener ? ` on listener ${String(t.listener)}` : ''}`, state: { gateway, resourceGroup: group, certificateName: name, serial: cert.serial ?? '' } };
  }

  // ---------- DigitalOcean: certificates and load balancers ----------

  private async doCall<T>(account: CloudAccount, cred: Record<string, unknown>, method: string, path: string, body?: unknown): Promise<T> {
    if (!cred.token) throw new CloudProviderError(`${account.name}'s credential is not a DigitalOcean token.`, 'digitalocean', 400, 'wrong_credential');
    const url = new URL(path, this.endpoints.digitalocean ?? 'https://api.digitalocean.com');
    const res = await this.transport('digitalocean').json<T>({ method, url, headers: { authorization: `Bearer ${String(cred.token)}` }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), accountId: account.id }, (status, b) => {
      const e = b as { id?: string; message?: string } | null;
      return { message: `DigitalOcean answered ${status}${e?.message ? `: ${e.message.slice(0, 200)}` : ''}`, code: e?.id ?? null };
    });
    return res.body;
  }

  private async pushDo(account: CloudAccount, cred: Record<string, unknown>, t: PushTarget, cert: PushCert) {
    const lbId = (t.loadBalancerId as string | undefined) ?? (await this.fromGraph(t, account.id)).providerId;
    const { leaf, chain } = splitChain(cert.chainPem);
    const name = `exprsn-${cert.name.replace(/[^A-Za-z0-9-]/g, '-').slice(0, 40)}-${(cert.serial ?? randomBytes(4).toString('hex')).slice(-8).toLowerCase()}`;
    const created = await this.doCall<{ certificate: { id: string } }>(account, cred, 'POST', '/v2/certificates', { name, type: 'custom', private_key: cert.keyPem, leaf_certificate: leaf, ...(chain ? { certificate_chain: chain } : {}) });
    const newId = created.certificate.id;
    const lb = (await this.doCall<{ load_balancer: Record<string, unknown> & { forwarding_rules?: Record<string, unknown>[] } }>(account, cred, 'GET', `/v2/load_balancers/${encodeURIComponent(lbId)}`)).load_balancer;
    const old = new Set<string>();
    const rules = (lb.forwarding_rules ?? []).map((r) => {
      if (r.entry_protocol !== 'https' && r.entry_protocol !== 'http2' && r.entry_protocol !== 'http3') return r;
      if (r.tls_passthrough) return r;
      if (r.certificate_id) old.add(String(r.certificate_id));
      return { ...r, certificate_id: newId };
    });
    if (!rules.some((r) => r.certificate_id === newId)) throw new Error('The load balancer has no HTTPS forwarding rule to serve the certificate.');
    const region = typeof lb.region === 'object' && lb.region ? (lb.region as { slug?: string }).slug : lb.region;
    const update: Record<string, unknown> = { name: lb.name, region, forwarding_rules: rules };
    for (const k of ['size', 'size_unit', 'health_check', 'sticky_sessions', 'redirect_http_to_https', 'enable_proxy_protocol', 'enable_backend_keepalive', 'http_idle_timeout_seconds', 'vpc_uuid', 'project_id', 'droplet_ids', 'tag', 'firewall', 'disable_lets_encrypt_dns_records']) if (lb[k] !== undefined && lb[k] !== null && !(k === 'droplet_ids' && lb.tag)) update[k] = lb[k];
    await this.doCall(account, cred, 'PUT', `/v2/load_balancers/${encodeURIComponent(lbId)}`, update);
    const removed: string[] = [];
    for (const id of old) {
      if (id === newId) continue;
      try {
        await this.doCall(account, cred, 'DELETE', `/v2/certificates/${encodeURIComponent(id)}`);
        removed.push(id);
      } catch {
        /* still in use elsewhere, or gone: kept */
      }
    }
    return { detail: `DigitalOcean certificate ${newId} on load balancer ${lbId}${removed.length ? `; ${removed.length} replaced certificate${removed.length === 1 ? '' : 's'} deleted` : ''}`, state: { certificateId: newId, loadBalancerId: lbId, serial: cert.serial ?? '' } };
  }
}
