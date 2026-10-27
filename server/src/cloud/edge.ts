import { timingSafeEqual } from 'node:crypto';
import { connect as tlsConnect } from 'node:tls';
import { isIP } from 'node:net';
import { ulid } from 'ulid';
import { z } from 'zod';
import type { Principal } from '../authz/policy.js';
import { ACCESS_ADMIN_PATHS, ACCESS_EXCLUSIONS, accessIssuer, underPrefix } from '../http/cloudflare-access.js';
import { CLOUDFLARE_IP_RANGES, cloudflareRanges } from '../http/cloudflare-ips.js';
import { conflict, HttpProblem, notFound } from '../http/problem.js';
import { metadataProblem } from '../platform/egress.js';
import type { Services } from '../services.js';
import type { CloudActor } from './accounts.js';
import { cloudAudit } from './audit.js';
import { CloudVault, CLOUD_KV_ROOT } from './cloud-vault.js';
import { renderWaf, serverLimits, WAF_PHASES, type CfPlan, type CfRule, type WafRender } from './edge-waf.js';
import { CloudProviderError, type CallContext, type ResourceSpec } from './providers/types.js';
import { cloudTags } from './tags.js';
import type { CloudflareProvider } from './providers/cloudflare.js';
import { CLOUDFLARE_FRONT_DOOR_CAP } from './spec.js';
import type { CloudAccount } from './types.js';

/*
 * 1.9.99-final, Sprint 61 (B-10901 to B-10904): the Cloudflare front door, for any deployment: a cloud deployment
 * (`deploymentId`) or an install without one (this install, Compose, bare metal or Helm on-prem). `s.cloud.edge`.
 *
 *   B-10901  DNS for the name and edge TLS, Full (strict) to the origin, as an alternative to ACME. Apply checks that
 *            Cloudflare's edge certificate for the name is active, sets SSL to strict (minimum TLS 1.2, HTTPS only),
 *            checks the origin's own certificate verifies for the name (a public origin; a tunnel's origin is local),
 *            and only then makes the record proxied. A name that answered DNS-only (the ACME setup) is switched in
 *            place: the same record becomes proxied first (the ACME certificate still serves Full strict), and only
 *            then is it pointed at the tunnel; the name never has no record and never serves without a certificate.
 *   B-10902  A named tunnel (`exprsn-<account>-edge-<name>`) created through the API, its token read once into the
 *            vault (`vault:cloud/edge/<id>#tunnel_token`, never returned by a route), its ingress set remotely
 *            (the name to the origin service, WebSocket upgrades included, anything else 404). `installFor` gives the
 *            settings for the chart, the systemd unit and the Compose file that run `cloudflared` beside the app with
 *            no inbound port.
 *   B-10903  The WAF and rate limits (`cloud/edge-waf.ts`), merged into each phase's entrypoint so rules this build
 *            did not write stay.
 *   B-10904  Cloudflare Access for the console (`configureAccess`), with Exprsn-AI's own OIDC provider (open decision
 *            20) or an identity provider already on the Cloudflare account; the server's own check is
 *            `http/cloudflare-access.ts`.
 *
 * Cloudflare's edge sees decrypted traffic: a front door caps what the deployment may hold at `confidential` (open
 * decision 5), checked for a cloud deployment against its label. Without migration 161 every call answers 503
 * `migration_pending`.
 */

const id26 = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'an id');
const hostname = z
  .string()
  .max(253)
  .transform((v) => v.trim().toLowerCase().replace(/\.$/, ''))
  .pipe(z.string().regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, 'a DNS name'));
const plans = ['free', 'pro', 'business', 'enterprise'] as const;

export const edgeCreateSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/, 'lower-case letters, digits and dashes, 3 to 40'),
    accountId: id26,
    deploymentId: id26.nullable().default(null),
    hostname,
    zone: hostname,
    plan: z.enum(plans).default('free'),
    origin: z.discriminatedUnion('kind', [
      // The tunnel's connector reaches the app here (http://127.0.0.1:8080, http://exprsn-ai.exprsn-ai.svc:80).
      z.object({ kind: z.literal('tunnel'), service: z.url().refine((u) => /^https?:\/\//.test(u), 'an http:// or https:// address') }).strict(),
      // A public origin keeps its own certificate (the ACME one) and gets the proxied record.
      z.object({ kind: z.literal('public'), address: z.string().min(1).max(253), port: z.number().int().min(1).max(65535).default(443) }).strict()
    ]),
    waf: z.object({ enabled: z.boolean().default(true), adminCidrs: z.array(z.string().regex(/^[0-9a-fA-F:.]+(\/\d{1,3})?$/)).max(20).default([]) }).strict().default({ enabled: true, adminCidrs: [] })
  })
  .strict();
export type EdgeCreateInput = z.input<typeof edgeCreateSchema>;

export const accessSchema = z
  .object({
    scope: z.enum(['admin', 'host']).default('admin'),
    teamDomain: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}\.cloudflareaccess\.com$/, '<team>.cloudflareaccess.com'),
    idp: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('exprsn'), clientId: z.string().min(1).max(100), clientSecret: z.string().min(8).max(500) }).strict(),
      z.object({ kind: z.literal('cloudflare'), identityProviderId: z.string().min(1).max(100) }).strict()
    ]),
    allowedEmails: z.array(z.string().email()).max(100).default([]),
    allowedDomains: z.array(hostname).max(20).default([]),
    sessionDuration: z.string().regex(/^\d{1,3}h$/).default('8h')
  })
  .strict();
export type AccessInput = z.input<typeof accessSchema>;

export interface EdgeRow {
  id: string;
  name: string;
  accountId: string;
  deploymentId: string | null;
  hostname: string;
  zone: string;
  plan: CfPlan;
  origin: { kind: 'tunnel'; service: string } | { kind: 'public'; address: string; port: number };
  waf: { enabled: boolean; adminCidrs: string[] };
  access: { scope: 'admin' | 'host'; teamDomain: string; idp: { kind: 'exprsn'; clientId: string } | { kind: 'cloudflare'; identityProviderId: string }; identityProviderId: string | null; appIds: string[] } | null;
  state: 'draft' | 'applied' | 'failed';
  switchedFrom: 'acme' | null;
  tunnelId: string | null;
  /** The vault reference of the tunnel token (never the token). */
  tokenRef: string | null;
  accessAud: string | null;
  steps: EdgeStep[];
  lastError: string | null;
  labelCap: typeof CLOUDFLARE_FRONT_DOOR_CAP;
  createdAt: number;
  updatedAt: number;
  appliedAt: number | null;
}

export interface EdgeStep {
  step: 'zone' | 'edge_certificate' | 'ssl' | 'origin_certificate' | 'tunnel' | 'tunnel_token' | 'tunnel_ingress' | 'dns' | 'waf' | 'access';
  ok: boolean;
  detail: string;
  at: number;
}

export const edgeMissing = () => new HttpProblem(503, 'Not installed', 'The Cloudflare front door needs the database migration 161_cloud_edge, which has not been applied.', { extensions: { reason: 'migration_pending' } });
export const edgeTokenPath = (id: string): string => `${CLOUD_KV_ROOT}/edge/${id.toLowerCase()}`;
export const tunnelCname = (tunnelId: string): string => `${tunnelId}.cfargotunnel.com`;

interface CfDnsRecord { id: string; name: string; type: string; content: string; proxied?: boolean; ttl: number; comment?: string | null }
interface CfCertPack { id: string; type: string; hosts: string[]; status: string }
interface CfRuleset { id: string; rules?: (CfRule & { id?: string })[] }
interface CfAccessApp { id: string; name: string; aud: string; domain: string; destinations?: { type: string; uri: string }[] }

/** What the origin's certificate check found. */
export interface OriginCheck {
  ok: boolean;
  detail: string;
  notAfter?: number;
}

export interface CloudEdgeOptions {
  /** Checks the public origin's certificate for the name (tests give a local server and its CA). */
  originCheck?: (address: string, port: number, hostname: string) => Promise<OriginCheck>;
  /** Trust anchors for the default origin check (tests). */
  originCa?: string;
}

/** Whether a certificate pack covers a name (exactly, or one label below a wildcard). */
export const packCovers = (hosts: string[], name: string): boolean => hosts.some((h) => h === name || (h.startsWith('*.') && name.endsWith(h.slice(1)) && !name.slice(0, -(h.length - 1)).includes('.')));

/** The rule merge of one phase: every rule this build did not write is kept, ours replaced. */
export function mergeRules(existing: (CfRule & { id?: string })[], ours: CfRule[]): CfRule[] {
  const keep = existing.filter((r) => !(r.ref ?? '').startsWith('exprsn-')).map(({ id: _id, ...r }) => r as CfRule);
  return [...ours, ...keep];
}

/** The Access applications the front door renders (B-10904), from the scope and the exclusions. */
export function renderAccessApps(edge: Pick<EdgeRow, 'name' | 'hostname'>, a: z.output<typeof accessSchema>, idpId: string): { protect: Record<string, unknown>; bypass: Record<string, unknown> | null } {
  const include: Record<string, unknown>[] = [...a.allowedEmails.map((email) => ({ email: { email } })), ...a.allowedDomains.map((domain) => ({ email_domain: { domain } }))];
  const protectPaths = a.scope === 'admin' ? ACCESS_ADMIN_PATHS.map((p) => `${edge.hostname}${p}`) : [edge.hostname];
  const protect = {
    name: `exprsn-${edge.name}-console`,
    type: 'self_hosted',
    domain: protectPaths[0],
    destinations: protectPaths.map((uri) => ({ type: 'public', uri })),
    allowed_idps: [idpId],
    auto_redirect_to_identity: true,
    session_duration: a.sessionDuration,
    app_launcher_visible: false,
    // Exprsn-AI's identity stays authoritative: Access is one more layer, and the session is still required.
    policies: [{ name: 'exprsn-allow', decision: 'allow', precedence: 1, include: include.length ? include : [{ everyone: {} }] }]
  };
  const bypass =
    a.scope === 'host'
      ? {
          name: `exprsn-${edge.name}-public`,
          type: 'self_hosted',
          domain: `${edge.hostname}${ACCESS_EXCLUSIONS[0]!.path}`,
          destinations: ACCESS_EXCLUSIONS.map((x) => ({ type: 'public', uri: `${edge.hostname}${x.path}` })),
          app_launcher_visible: false,
          policies: [{ name: 'exprsn-bypass', decision: 'bypass', precedence: 1, include: [{ everyone: {} }] }]
        }
      : null;
  return { protect, bypass };
}

/**
 * Which Access application answers a path, as Access picks one: the destination with the longest matching path on
 * the host wins. Null when no application covers the path (the request never sees Access).
 */
export function accessAppFor(apps: { name: string; destinations: { uri: string }[]; policies?: { decision: string }[] }[], host: string, path: string): { name: string; decision: string } | null {
  let best: { name: string; decision: string; len: number } | null = null;
  for (const app of apps) {
    for (const d of app.destinations) {
      const slash = d.uri.indexOf('/');
      const h = slash < 0 ? d.uri : d.uri.slice(0, slash);
      const p = slash < 0 ? '' : d.uri.slice(slash);
      if (h !== host) continue;
      if (p && !underPrefix(path, p)) continue;
      if (!best || p.length > best.len) best = { name: app.name, decision: app.policies?.[0]?.decision ?? 'allow', len: p.length };
    }
  }
  return best ? { name: best.name, decision: best.decision } : null;
}

/** The default origin check: a TLS handshake with the name as SNI, verified against the system's (or the given) CAs. */
export function probeOrigin(address: string, port: number, name: string, ca?: string): Promise<OriginCheck> {
  const meta = metadataProblem(address);
  if (meta) return Promise.resolve({ ok: false, detail: meta });
  return new Promise((resolve) => {
    const sock = tlsConnect({ host: address, port, servername: isIP(name) ? undefined : name, rejectUnauthorized: true, ...(ca ? { ca } : {}), timeout: 10_000 }, () => {
      const cert = sock.getPeerCertificate();
      sock.end();
      resolve({ ok: true, detail: `The origin's certificate verifies for ${name}${cert?.valid_to ? ` until ${new Date(cert.valid_to).toISOString().slice(0, 10)}` : ''}.`, ...(cert?.valid_to ? { notAfter: Date.parse(cert.valid_to) } : {}) });
    });
    sock.on('timeout', () => {
      sock.destroy();
      resolve({ ok: false, detail: `The origin ${address}:${port} did not answer TLS within 10 s.` });
    });
    sock.on('error', (err) => resolve({ ok: false, detail: `The origin's certificate does not verify for ${name}: ${err.message}` }));
  });
}

export class CloudEdge {
  private schemaAt = 0;
  private schemaOk = false;
  readonly options: CloudEdgeOptions = {};

  constructor(private readonly s: () => Services) {}

  async installed(): Promise<boolean> {
    if (this.schemaOk) return true;
    if (Date.now() - this.schemaAt < 60_000) return false;
    this.schemaAt = Date.now();
    this.schemaOk = await this.s().db.schema.hasTable('cloud_edge');
    return this.schemaOk;
  }

  resetSchemaCache(): void {
    this.schemaAt = 0;
    this.schemaOk = false;
  }

  async need(): Promise<void> {
    if (!(await this.installed())) throw edgeMissing();
  }

  // ---------- rows ----------

  private fromRow(r: Record<string, unknown>): EdgeRow {
    const j = <T>(v: unknown, d: T): T => (v == null ? d : typeof v === 'string' ? (JSON.parse(v) as T) : (v as T));
    return {
      id: String(r.id),
      name: String(r.name),
      accountId: String(r.account_id),
      deploymentId: (r.deployment_id as string | null) ?? null,
      hostname: String(r.hostname),
      zone: String(r.zone),
      plan: String(r.plan) as CfPlan,
      origin: j(r.origin, { kind: 'tunnel', service: '' } as EdgeRow['origin']),
      waf: j(r.waf, { enabled: true, adminCidrs: [] }),
      access: j(r.access, null as EdgeRow['access']),
      state: String(r.state) as EdgeRow['state'],
      switchedFrom: (r.switched_from as 'acme' | null) ?? null,
      tunnelId: (r.tunnel_id as string | null) ?? null,
      tokenRef: (r.token_ref as string | null) ?? null,
      accessAud: (r.access_aud as string | null) ?? null,
      steps: j(r.steps, [] as EdgeStep[]),
      lastError: (r.last_error as string | null) ?? null,
      labelCap: CLOUDFLARE_FRONT_DOOR_CAP,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
      appliedAt: r.applied_at == null ? null : Number(r.applied_at)
    };
  }

  async list(_p: Principal): Promise<EdgeRow[]> {
    await this.need();
    return ((await this.s().db('cloud_edge').orderBy('created_at', 'asc')) as Record<string, unknown>[]).map((r) => this.fromRow(r));
  }

  async get(id: string): Promise<EdgeRow> {
    await this.need();
    const r = (await this.s().db('cloud_edge').where({ id }).first()) as Record<string, unknown> | undefined;
    if (!r) throw notFound('Front door');
    return this.fromRow(r);
  }

  /** The front door's Cloudflare account; `change`: the caller changes what lives on it (platform:manage too). */
  private async cloudflareAccount(p: Principal, accountId: string, change = true): Promise<CloudAccount> {
    const accounts = this.s().cloud.accounts;
    const a = await accounts.getFor(p, accountId);
    if (a.provider !== 'cloudflare') throw conflict(`${a.name} is not a Cloudflare account.`);
    if (a.scope !== 'platform') throw conflict(`${a.name} is a tenant account; a front door needs a platform Cloudflare account.`);
    if (change) accounts.assertCanChange(p, a);
    return a;
  }

  async create(actor: CloudActor, input: z.output<typeof edgeCreateSchema>): Promise<EdgeRow> {
    await this.need();
    if (input.hostname !== input.zone && !input.hostname.endsWith(`.${input.zone}`)) throw conflict(`${input.hostname} is not in the DNS zone ${input.zone}.`);
    const account = await this.cloudflareAccount(actor.principal, input.accountId);
    if (input.deploymentId) {
      const d = await this.s().cloud.deployments.getFor(actor.principal, input.deploymentId);
      if (d.label === 'restricted') throw conflict(`Cloudflare's edge sees decrypted traffic, so a deployment behind it holds at most ${CLOUDFLARE_FRONT_DOOR_CAP}; ${d.name} holds restricted data.`);
    }
    const db = this.s().db;
    if (await db('cloud_edge').where({ name: input.name }).orWhere({ hostname: input.hostname }).first('id')) throw conflict(`A front door named ${input.name} or for ${input.hostname} exists already.`);
    const now = Date.now();
    const id = ulid();
    await db('cloud_edge').insert({ id, name: input.name, account_id: account.id, deployment_id: input.deploymentId, hostname: input.hostname, zone: input.zone, plan: input.plan, origin: JSON.stringify(input.origin), waf: JSON.stringify(input.waf), access: null, state: 'draft', switched_from: null, tunnel_id: null, token_ref: null, access_aud: null, steps: null, last_error: null, created_by: actor.principal.userId, created_tenant: actor.principal.tenantId, created_at: now, updated_at: now, applied_at: null });
    await cloudAudit(this.s(), { tenantId: actor.principal.tenantId, action: 'cloud.edge.created', actor, deploymentId: input.deploymentId, detail: { edge: id, name: input.name, hostname: input.hostname, account: account.id, origin: input.origin.kind, plan: input.plan } });
    return this.get(id);
  }

  /** What apply would do, without calling Cloudflare: the WAF render, the Access exclusions, the install settings. */
  async render(id: string): Promise<{ edge: EdgeRow; waf: WafRender | null; accessExclusions: typeof ACCESS_EXCLUSIONS; ranges: { asOf: string; count: number } }> {
    const edge = await this.get(id);
    return { edge, waf: edge.waf.enabled ? renderWaf(serverLimits(this.s().cfg), edge.plan, { adminCidrs: edge.waf.adminCidrs }) : null, accessExclusions: ACCESS_EXCLUSIONS, ranges: { asOf: CLOUDFLARE_IP_RANGES.asOf, count: cloudflareRanges().length } };
  }

  // ---------- Cloudflare calls ----------

  private async context(account: CloudAccount): Promise<{ cf: CloudflareProvider; ctx: CallContext }> {
    const s = this.s();
    if (!s.cloud.credentials) throw new HttpProblem(503, 'Not available', 'Cloud credentials are not available in this build.', { extensions: { reason: 'cloud_component_missing' } });
    const cred = (await s.cloud.credentials.for(account, 'deploy')) as CallContext['cred'];
    const cf = await s.cloud.providers.adapter('cloudflare');
    return { cf, ctx: { account, cred } };
  }

  private accId(account: CloudAccount): string {
    const id = account.providerIds.cloudflareAccountId;
    if (!id) throw conflict(`${account.name} has no Cloudflare account id.`);
    return encodeURIComponent(id);
  }

  private async zoneId(cf: CloudflareProvider, ctx: CallContext, zone: string): Promise<string> {
    const r = await cf.edgeCall<{ id: string; name: string }[]>(ctx, 'GET', `/zones?name=${encodeURIComponent(zone)}`);
    const z = r.result.find((x) => x.name === zone);
    if (!z) throw conflict(`No Cloudflare zone ${zone} for this account's token.`);
    return z.id;
  }

  /**
   * Applies the front door in order: zone, edge certificate, SSL, origin certificate (public origin), tunnel, DNS,
   * WAF. A failing step stops the apply before anything later changes; each step's result is kept on the row.
   */
  async apply(actor: CloudActor, id: string): Promise<EdgeRow> {
    const s = this.s();
    const edge = await this.get(id);
    const account = await this.cloudflareAccount(actor.principal, edge.accountId);
    const { cf, ctx } = await this.context(account);
    const steps: EdgeStep[] = [];
    // The step in progress, named in a failure (the last finished one may be an earlier step).
    let current: EdgeStep['step'] = 'zone';
    const step = (st: EdgeStep['step'], ok: boolean, detail: string) => void steps.push({ step: st, ok, detail, at: Date.now() });
    const begin = (st: EdgeStep['step']) => void (current = st);
    const patch: Record<string, unknown> = {};
    const fail = async (err: unknown): Promise<never> => {
      const msg = err instanceof Error ? err.message : String(err);
      await s.db('cloud_edge').where({ id }).update({ ...patch, state: 'failed', steps: JSON.stringify(steps), last_error: msg.slice(0, 2000), updated_at: Date.now() });
      await cloudAudit(s, { tenantId: actor.principal.tenantId, action: 'cloud.edge.apply.failed', actor, deploymentId: edge.deploymentId, detail: { edge: id, name: edge.name, step: current, reason: msg.slice(0, 300) } });
      if (err instanceof HttpProblem) throw err;
      throw new HttpProblem(err instanceof CloudProviderError && err.status < 500 ? 409 : 502, 'Front door not applied', msg, { extensions: { reason: 'edge_apply_failed', step: current, steps } });
    };
    try {
      const zoneId = await this.zoneId(cf, ctx, edge.zone);
      step('zone', true, `${edge.zone} is zone ${zoneId}.`);
      const z = encodeURIComponent(zoneId);

      // B-10901: the edge certificate first; nothing changes while Cloudflare cannot serve the name.
      begin('edge_certificate');
      const packs = await cf.edgeList<CfCertPack>(ctx, `/zones/${z}/ssl/certificate_packs?status=all`);
      const pack = packs.find((p) => p.status === 'active' && packCovers(p.hosts, edge.hostname));
      if (!pack) {
        step('edge_certificate', false, `Cloudflare has no active edge certificate for ${edge.hostname} yet (${packs.map((p) => `${p.type} ${p.status}`).join(', ') || 'no certificate packs'}); nothing was changed.`);
        return await fail(new HttpProblem(409, 'Edge certificate pending', `Cloudflare has no active edge certificate for ${edge.hostname} yet; nothing was changed. Apply again once it is active.`, { extensions: { reason: 'edge_certificate_pending', steps } }));
      }
      step('edge_certificate', true, `The ${pack.type} certificate ${pack.id} covers ${edge.hostname}.`);

      begin('ssl');
      for (const [name, value] of [['ssl', 'strict'], ['min_tls_version', '1.2'], ['always_use_https', 'on']] as const) await cf.edgeCall(ctx, 'PATCH', `/zones/${z}/settings/${name}`, { value });
      step('ssl', true, 'SSL is Full (strict), minimum TLS 1.2, HTTPS only.');

      let target: { type: 'CNAME' | 'A' | 'AAAA'; content: string };
      if (edge.origin.kind === 'public') {
        const o = edge.origin;
        begin('origin_certificate');
        const check = await (this.options.originCheck ?? ((a: string, p: number, n: string) => probeOrigin(a, p, n, this.options.originCa)))(o.address, o.port, edge.hostname);
        step('origin_certificate', check.ok, check.detail);
        if (!check.ok) return await fail(new HttpProblem(409, 'Origin certificate', `${check.detail} Full (strict) needs it; the record was not changed.`, { extensions: { reason: 'origin_certificate', steps } }));
        target = { type: isIP(o.address) === 6 ? 'AAAA' : isIP(o.address) === 4 ? 'A' : 'CNAME', content: o.address.toLowerCase() };
      } else {
        begin('tunnel');
        const t = await this.ensureTunnel(cf, ctx, account, edge, step, patch);
        target = { type: 'CNAME', content: tunnelCname(t) };
      }

      begin('dns');
      const switched = await this.switchRecord(cf, ctx, z, edge, account, target);
      step('dns', true, switched.detail);
      patch.switched_from = switched.from ?? edge.switchedFrom;

      if (edge.waf.enabled) {
        begin('waf');
        const waf = renderWaf(serverLimits(s.cfg), edge.plan, { adminCidrs: edge.waf.adminCidrs });
        for (const phase of WAF_PHASES) {
          let existing: CfRuleset | null = null;
          try {
            existing = (await cf.edgeCall<CfRuleset>(ctx, 'GET', `/zones/${z}/rulesets/phases/${phase}/entrypoint`)).result;
          } catch (err) {
            if (!(err instanceof CloudProviderError && err.status === 404)) throw err;
          }
          await cf.edgeCall(ctx, 'PUT', `/zones/${z}/rulesets/phases/${phase}/entrypoint`, { rules: mergeRules(existing?.rules ?? [], waf.phases[phase]) });
        }
        step('waf', true, `${waf.phases.http_ratelimit.length} rate limiting rule(s) on the ${edge.plan} plan, managed rules, and the socket and streams exempt from buffering.`);
      }
    } catch (err) {
      return fail(err);
    }
    const now = Date.now();
    await s.db('cloud_edge').where({ id }).update({ ...patch, state: 'applied', steps: JSON.stringify(steps), last_error: null, updated_at: now, applied_at: now });
    await cloudAudit(s, { tenantId: actor.principal.tenantId, action: 'cloud.edge.applied', actor, deploymentId: edge.deploymentId, detail: { edge: id, name: edge.name, hostname: edge.hostname, origin: edge.origin.kind, steps: steps.map((x) => x.step), switchedFrom: patch.switched_from ?? null } });
    // Sprint 62 (B-10209): an on-prem deployment's tunnel and record join its graph, so drift reads them.
    if (edge.deploymentId) {
      const applied = await this.get(id);
      await (await import('./onprem.js')).recordFrontDoor(s, applied).catch((err: unknown) => s.log.warn({ err, edge: id }, 'recording the on-prem front door failed'));
    }
    return this.get(id);
  }

  /** B-10902: the named tunnel, its token in the vault, its ingress. Returns the tunnel id. */
  private async ensureTunnel(cf: CloudflareProvider, ctx: CallContext, account: CloudAccount, edge: EdgeRow, step: (st: EdgeStep['step'], ok: boolean, detail: string) => void, patch: Record<string, unknown>): Promise<string> {
    const acc = this.accId(account);
    const spec: ResourceSpec<'tunnel'> = { type: 'tunnel', name: `edge-${edge.name}`, idempotencyKey: `edge-tunnel:${edge.id}`, tags: cloudTags({ account: account.name, deployment: edge.deploymentId ? edge.name : 'edge' }), props: {} };
    const made = await cf.create(ctx, spec);
    if (!made.done || !made.resource) throw new Error('Cloudflare did not answer the tunnel.');
    const tunnel = made.resource!;
    step('tunnel', true, `${made.adopted ? 'Found' : 'Created'} the tunnel ${tunnel.providerId}.`);
    patch.tunnel_id = tunnel.providerId;
    const t = encodeURIComponent(tunnel.providerId);
    // The token is read once into the vault; no route or log ever carries it.
    if (!edge.tokenRef || edge.tunnelId !== tunnel.providerId) {
      const token = (await cf.edgeCall<string>(ctx, 'GET', `/accounts/${acc}/cfd_tunnel/${t}/token`)).result;
      if (typeof token !== 'string' || token.length < 20) throw new Error('Cloudflare answered no tunnel token.');
      const out = await new CloudVault(this.s).write(edgeTokenPath(edge.id), { tunnel_token: token });
      patch.token_ref = out.refs.tunnel_token;
      step('tunnel_token', true, `The tunnel token is in the vault (${out.refs.tunnel_token}, version ${out.version}).`);
    } else step('tunnel_token', true, `The tunnel token is in the vault (${edge.tokenRef}).`);
    const service = (edge.origin as { service: string }).service;
    // cloudflared forwards WebSocket upgrades on every rule; /socket.io/ needs nothing more than reaching the app.
    const ingress = [{ hostname: edge.hostname, service, originRequest: { httpHostHeader: edge.hostname, connectTimeout: 30, keepAliveTimeout: 90 } }, { service: 'http_status:404' }];
    await cf.edgeCall(ctx, 'PUT', `/accounts/${acc}/cfd_tunnel/${t}/configurations`, { config: { ingress } });
    step('tunnel_ingress', true, `${edge.hostname} goes to ${service} through the tunnel (WebSocket upgrades included); anything else answers 404.`);
    return tunnel.providerId;
  }

  /**
   * The name's record, switched with no gap: every A, AAAA or CNAME of the name becomes proxied in place first (an
   * ACME setup's DNS-only record keeps its origin, whose certificate serves Full strict), extra records are removed
   * only while one proxied record remains, and the last one is pointed at the target. A name without a record gets
   * one.
   */
  private async switchRecord(cf: CloudflareProvider, ctx: CallContext, z: string, edge: EdgeRow, account: CloudAccount, target: { type: string; content: string }): Promise<{ detail: string; from: 'acme' | null }> {
    const all = await cf.edgeList<CfDnsRecord>(ctx, `/zones/${z}/dns_records?name=${encodeURIComponent(edge.hostname)}`);
    const records = all.filter((r) => r.name === edge.hostname && ['A', 'AAAA', 'CNAME'].includes(r.type));
    const comment = `exprsn:managed=true exprsn:account=${account.name} exprsn:frontdoor=${edge.name}`.slice(0, 100);
    if (!records.length) {
      await cf.edgeCall(ctx, 'POST', `/zones/${z}/dns_records`, { type: target.type, name: edge.hostname, content: target.content, proxied: true, ttl: 1, comment });
      return { detail: `Created the proxied ${target.type} record ${edge.hostname} → ${target.content}.`, from: null };
    }
    const from: 'acme' | null = records.some((r) => !r.proxied) ? 'acme' : null;
    // 1. Proxied in place: the content stays, so the origin (and its certificate) keeps serving.
    for (const r of records) if (!r.proxied) await cf.edgeCall(ctx, 'PATCH', `/zones/${z}/dns_records/${encodeURIComponent(r.id)}`, { proxied: true, ttl: 1 });
    // 2. Only one record may hold a CNAME: the others go while the kept one is proxied.
    const keep = records.find((r) => r.type === target.type && r.content === target.content) ?? records[0]!;
    for (const r of records) if (r.id !== keep.id) await cf.edgeCall(ctx, 'DELETE', `/zones/${z}/dns_records/${encodeURIComponent(r.id)}`);
    // 3. The kept record points at the target (behind the proxy, so clients see no change).
    if (keep.type !== target.type || keep.content !== target.content || keep.comment !== comment) await cf.edgeCall(ctx, 'PATCH', `/zones/${z}/dns_records/${encodeURIComponent(keep.id)}`, { type: target.type, content: target.content, proxied: true, ttl: 1, comment });
    return { detail: `${from ? 'Switched from DNS-only (ACME)' : 'Kept'} ${edge.hostname}: proxied in place, then ${target.type} → ${target.content}.`, from };
  }

  // ---------- B-10904: Access ----------

  async configureAccess(actor: CloudActor, id: string, a: z.output<typeof accessSchema>): Promise<EdgeRow> {
    const s = this.s();
    const edge = await this.get(id);
    if (a.idp.kind === 'exprsn' && a.scope === 'host') throw conflict("With Exprsn-AI's own OIDC provider as Access's identity provider, Access protects the admin console only (scope admin): the sign-in page Access sends people to is this console, which a host-wide application would put behind Access itself.");
    if (a.idp.kind === 'exprsn' && edge.deploymentId) throw conflict("Exprsn-AI's own OIDC provider is offered for this install's front door; for a cloud deployment, register the client on that deployment and give its Access identity provider (kind cloudflare).");
    const account = await this.cloudflareAccount(actor.principal, edge.accountId);
    const { cf, ctx } = await this.context(account);
    const acc = this.accId(account);
    const callback = `https://${a.teamDomain}/cdn-cgi/access/callback`;

    let idpId: string;
    if (a.idp.kind === 'exprsn') {
      const client = await s.federation.oidc.byClientId(actor.principal.tenantId, a.idp.clientId);
      if (!client || client.status !== 'active') throw conflict(`No active OIDC client ${a.idp.clientId} in this tenant; register one under Federation with the redirect address ${callback}.`);
      if (client.type === 'public' || !client.secret_hash) throw conflict(`${client.name} is a public client; Access needs a confidential one.`);
      if (!client.redirect_uris.includes(callback)) throw conflict(`${client.name} does not list ${callback} as a redirect address.`);
      if (!client.scopes.includes('openid') || !client.scopes.includes('email')) throw conflict(`${client.name} needs the scopes openid and email.`);
      const digest = Buffer.from(s.federation.oidc.digest('secret', a.idp.clientSecret));
      const held = Buffer.from(client.secret_hash);
      if (digest.length !== held.length || !timingSafeEqual(digest, held)) throw conflict(`That is not ${client.name}'s current secret.`);
      const tenant = await s.tenants.byId(actor.principal.tenantId);
      const ctxT = tenant ? await s.federation.tenantBySlug(tenant.slug) : null;
      const issuer = ctxT?.issuer ?? s.cfg.ORIGIN;
      const config = { client_id: client.client_id, client_secret: a.idp.clientSecret, auth_url: `${issuer}/oauth/authorize`, token_url: `${issuer}/oauth/token`, certs_url: `${issuer}/.well-known/jwks.json`, scopes: ['openid', 'email', 'profile'], claims: ['email'], pkce_enabled: true };
      const name = `exprsn-${edge.name}`;
      const have = (await cf.edgeList<{ id: string; name: string }>(ctx, `/accounts/${acc}/access/identity_providers`)).find((x) => x.name === name);
      idpId = have
        ? (await cf.edgeCall<{ id: string }>(ctx, 'PUT', `/accounts/${acc}/access/identity_providers/${encodeURIComponent(have.id)}`, { name, type: 'oidc', config })).result.id
        : (await cf.edgeCall<{ id: string }>(ctx, 'POST', `/accounts/${acc}/access/identity_providers`, { name, type: 'oidc', config })).result.id;
    } else {
      idpId = (await cf.edgeCall<{ id: string }>(ctx, 'GET', `/accounts/${acc}/access/identity_providers/${encodeURIComponent(a.idp.identityProviderId)}`)).result.id;
    }

    const { protect, bypass } = renderAccessApps(edge, a, idpId);
    const existing = await cf.edgeList<CfAccessApp>(ctx, `/accounts/${acc}/access/apps`);
    const upsert = async (app: Record<string, unknown>): Promise<CfAccessApp> => {
      const have = existing.find((x) => x.name === app.name);
      return have ? (await cf.edgeCall<CfAccessApp>(ctx, 'PUT', `/accounts/${acc}/access/apps/${encodeURIComponent(have.id)}`, app)).result : (await cf.edgeCall<CfAccessApp>(ctx, 'POST', `/accounts/${acc}/access/apps`, app)).result;
    };
    const p = await upsert(protect);
    const appIds = [p.id];
    if (bypass) appIds.push((await upsert(bypass)).id);
    else {
      // Scope admin: a bypass application left from an earlier host-wide setup would widen nothing, but it goes.
      const old = existing.find((x) => x.name === `exprsn-${edge.name}-public`);
      if (old) await cf.edgeCall(ctx, 'DELETE', `/accounts/${acc}/access/apps/${encodeURIComponent(old.id)}`);
    }
    const access: EdgeRow['access'] = { scope: a.scope, teamDomain: a.teamDomain, idp: a.idp.kind === 'exprsn' ? { kind: 'exprsn', clientId: a.idp.clientId } : { kind: 'cloudflare', identityProviderId: a.idp.identityProviderId }, identityProviderId: idpId, appIds };
    await s.db('cloud_edge').where({ id }).update({ access: JSON.stringify(access), access_aud: p.aud, updated_at: Date.now() });
    await cloudAudit(s, { tenantId: actor.principal.tenantId, action: 'cloud.edge.access', actor, deploymentId: edge.deploymentId, detail: { edge: id, name: edge.name, scope: a.scope, idp: a.idp.kind, apps: appIds, issuer: accessIssuer(a.teamDomain) } });
    return this.get(id);
  }

  // ---------- B-10902: what runs cloudflared ----------

  /**
   * The settings that run `cloudflared` beside the app with no inbound port, for one target. The manifests themselves
   * are the shipped ones (`deploy/helm/exprsn-ai` with `cloudflared.enabled`, `deploy/baremetal/exprsn-cloudflared.service`,
   * `deploy/docker/compose.tunnel.yml`); the token is written to a file from the vault with
   * `exprsn-ai cloud:tunnel-token`, never put in values or the environment.
   */
  async installFor(id: string, target: 'helm' | 'systemd' | 'compose'): Promise<Record<string, unknown>> {
    const edge = await this.get(id);
    if (edge.origin.kind !== 'tunnel') throw conflict(`${edge.name} has a public origin; there is no tunnel to run.`);
    const tokenCmd = (out: string) => `exprsn-ai cloud:tunnel-token --edge ${edge.name} --out ${out}`;
    const common = { edge: edge.name, hostname: edge.hostname, tunnelId: edge.tunnelId, tokenRef: edge.tokenRef, image: CLOUDFLARED_IMAGE, ingress: { hostname: edge.hostname, service: edge.origin.service, websocket: '/socket.io/' } };
    if (target === 'helm')
      return {
        ...common,
        values: { config: { trustProxy: 'uniquelocal,cloudflare', extra: { CLOUDFLARE_TUNNEL_PEERS: 'uniquelocal' } }, ingress: { enabled: false }, service: { type: 'ClusterIP' }, cloudflared: { enabled: true, tokenSecret: { name: 'exprsn-ai-cloudflared', key: 'token' } } },
        steps: [`${tokenCmd('./token')}`, 'kubectl -n <namespace> create secret generic exprsn-ai-cloudflared --from-file=token=./token && rm ./token', 'helm upgrade --install exprsn-ai deploy/helm/exprsn-ai -f <your values> -f <these values>'],
        inboundPorts: []
      };
    if (target === 'systemd')
      return {
        ...common,
        unit: 'deploy/baremetal/exprsn-cloudflared.service',
        env: { HOST: '127.0.0.1', TRUST_PROXY: 'loopback,cloudflare', CLOUDFLARE_TUNNEL_PEERS: 'loopback' },
        steps: [`${tokenCmd('/etc/exprsn-ai/credentials/cloudflared_token')}`, 'install -m 0644 deploy/baremetal/exprsn-cloudflared.service /etc/systemd/system/', 'systemctl daemon-reload && systemctl enable --now exprsn-cloudflared', 'systemctl restart exprsn-ai'],
        inboundPorts: []
      };
    return {
      ...common,
      file: 'deploy/docker/compose.tunnel.yml',
      env: { TRUST_PROXY: 'loopback,cloudflare', CLOUDFLARE_TUNNEL_PEERS: 'uniquelocal' },
      steps: [`${tokenCmd('deploy/docker/secrets/cloudflared_token.txt')}`, 'docker compose -f compose.yml -f compose.tunnel.yml up -d'],
      inboundPorts: []
    };
  }

  /** The tunnel token from the vault, for `exprsn-ai cloud:tunnel-token` only (it writes a 0600 file). */
  async tunnelToken(name: string): Promise<string> {
    await this.need();
    const r = (await this.s().db('cloud_edge').where({ name }).first()) as Record<string, unknown> | undefined;
    if (!r) throw notFound('Front door');
    const edge = this.fromRow(r);
    if (!edge.tokenRef) throw conflict(`${edge.name} has no tunnel token yet; apply it first.`);
    return new CloudVault(this.s).read(edge.tokenRef);
  }

  // ---------- the maintained ranges ----------

  /** The shipped Cloudflare ranges, and (with an account) what Cloudflare's API publishes now and the difference. */
  async ranges(p: Principal, accountId?: string): Promise<{ asOf: string; source: string; shipped: string[]; live?: string[]; added?: string[]; removed?: string[] }> {
    const shipped = this.s().cfg.CLOUDFLARE_IP_RANGES.trim() ? this.s().cfg.CLOUDFLARE_IP_RANGES.split(',').map((x) => x.trim()).filter(Boolean) : cloudflareRanges();
    const out = { asOf: CLOUDFLARE_IP_RANGES.asOf, source: CLOUDFLARE_IP_RANGES.source, shipped };
    if (!accountId) return out;
    const account = await this.cloudflareAccount(p, accountId, false);
    const { cf, ctx } = await this.context(account);
    const r = (await cf.edgeCall<{ ipv4_cidrs: string[]; ipv6_cidrs: string[] }>(ctx, 'GET', '/ips')).result;
    const live = [...r.ipv4_cidrs, ...r.ipv6_cidrs];
    return { ...out, live, added: live.filter((x) => !shipped.includes(x)), removed: shipped.filter((x) => !live.includes(x)) };
  }
}

/**
 * The `cloudflared` image the chart, the Compose file and the docs run, pinned to a release more than two weeks old
 * (2025.8.1). Pin its digest in the chart's `cloudflared.image.digest` where the registry is mirrored.
 */
export const CLOUDFLARED_IMAGE = 'cloudflare/cloudflared:2025.8.1';
