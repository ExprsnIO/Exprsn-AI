import { generateKeyPairSync } from 'node:crypto';
import { createPipelineRequest, type Pipeline } from '@azure/core-rest-pipeline';
import { bootstrapUserData, fileName, installStatusFrom, SECRET_MOUNT } from '../compute.js';
import { namePrefix } from '../tags.js';
import { azureHttpClient } from './sdk-bridges.js';
import type { CloudTransport } from './transport.js';
import { CloudProviderError, type CallContext, type InstallStatus, type ObservedResource, type OperationHandle, type OperationResult, type PollResult, type ResourceRef, type ResourceSpec } from './types.js';

/*
 * 1.9.99-final, Sprint 58 (B-10204, B-10205): the Azure adapter's compute, over raw ARM requests through the
 * clients' pipeline (token policy and all) and `CloudTransport`. `azure.ts` delegates its `vm` and
 * `container_service` cases here.
 *
 * Virtual machines (`vm`): a network interface in the app subnet with the zone's NSG and no public address, then the
 * VM (Ubuntu 24.04, Trusted Launch with a vTPM, so `systemd-creds` can seal the credentials to it; password sign-in
 * off and an SSH key nobody holds; boot diagnostics on), the cloud-init user data as `customData` with the
 * single-use wrapped token put in at create time. PUT by name, so a retried create is the same VM. The installer's
 * lines come from the serial console log (`retrieveBootDiagnosticsData`, read through the transport without the ARM
 * token; the SAS URL is Azure's).
 *
 * Container Apps (`container_service`): the managed environment in the app subnet (internal behind a tunnel), the
 * migration as a manual job started and followed to `Succeeded` before the app is put, then the app in single
 * revision mode (the revision suffix is the release version) with its secrets as Container Apps secrets mounted as
 * files (`<NAME>_FILE`), never as variables, and the readiness probe on `/readyz`. One long-running operation
 * (`azure-apps`), the phase in the token as JSON.
 */

export interface AzureComputeHost {
  transport: CloudTransport;
  arm: () => string;
  pipeline(ctx: CallContext): Pipeline;
  subscription(ctx: CallContext): string;
  rg(ctx: CallContext): string;
  location(ctx: CallContext, spec?: ResourceSpec): string;
  ensureGroup(ctx: CallContext, spec: ResourceSpec): Promise<string>;
}

const API = { compute: '2024-07-01', network: '2024-05-01', apps: '2024-03-01' };
const NAME_TAG = 'exprsn:name';
const managed = (t: Record<string, string> | undefined) => Object.fromEntries(Object.entries(t ?? {}).filter(([k]) => k.startsWith('exprsn:')));

interface Arm<T = Record<string, unknown>> {
  status: number;
  body: T;
  headers: Record<string, string>;
}

interface AppsPhase {
  phase: 'rollout' | 'delete';
  op: 'create' | 'update';
  /** The desired spec (settings and secret references only, never a value) the reconcile works towards. */
  spec?: Omit<ResourceSpec<'container_service'>, 'idempotencyKey'>;
  /** A delete: the environment's async operation URL. */
  follow?: string | null;
}

/** An OpenSSH `ssh-rsa` public key whose private half is thrown away: Azure wants a key, nobody signs in. */
function throwawaySshKey(): string {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
  const mpint = (b64: string) => {
    let b = Buffer.from(b64, 'base64url');
    if (b[0]! & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
    return b;
  };
  const part = (b: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(b.length);
    return Buffer.concat([len, b]);
  };
  return `ssh-rsa ${Buffer.concat([part(Buffer.from('ssh-rsa')), part(mpint(jwk.e)), part(mpint(jwk.n))]).toString('base64')} exprsn-no-login`;
}

export class AzureCompute {
  constructor(private readonly h: AzureComputeHost) {}

  private async send<T = Record<string, unknown>>(ctx: CallContext, method: string, url: string, body?: unknown): Promise<Arm<T>> {
    const target = new URL(url, `${this.h.arm()}/`);
    if (target.origin !== new URL(this.h.arm()).origin) throw new CloudProviderError(`Refusing an ARM call off the ARM endpoint (${target.host}).`, 'azure', 502, 'foreign_operation_url');
    const req = createPipelineRequest({ url: target.toString(), method: method as 'GET', ...(body !== undefined ? { body: JSON.stringify(body) } : {}), ...(target.protocol === 'http:' ? { allowInsecureConnection: true } : {}) });
    if (body !== undefined) req.headers.set('content-type', 'application/json');
    const res = await this.h.pipeline(ctx).sendRequest(azureHttpClient(this.h.transport, ctx.account.id), req);
    let parsed: unknown = null;
    if (res.bodyAsText) {
      try {
        parsed = JSON.parse(res.bodyAsText);
      } catch {
        parsed = res.bodyAsText;
      }
    }
    return { status: res.status, body: (parsed ?? {}) as T, headers: res.headers.toJSON() };
  }

  private fail(r: Arm<unknown>, what: string): CloudProviderError {
    const e = ((r.body as { error?: { code?: string; message?: string } }).error ?? {}) as { code?: string; message?: string };
    return new CloudProviderError(`Azure answered ${r.status} for ${what}${e.code ? ` (${e.code})` : ''}: ${(e.message ?? 'no detail').slice(0, 300)}`, 'azure', r.status, e.code ?? null, r.headers['x-ms-request-id'] ?? null, r.status === 429 ? Number(r.headers['retry-after']) || 1 : null);
  }

  private base(ctx: CallContext): string {
    return `/subscriptions/${this.h.subscription(ctx)}/resourceGroups/${this.h.rg(ctx)}/providers`;
  }

  private armName(ctx: CallContext, spec: { name: string }): string {
    return `${namePrefix(ctx.account.name)}${spec.name}`;
  }

  /** The URL a submitted PUT or DELETE is followed by (Azure-AsyncOperation or Location), or null when it is done. */
  private followOf(r: Arm<unknown>): string | null {
    return r.headers['azure-asyncoperation'] ?? (r.status === 202 ? (r.headers.location ?? null) : null);
  }

  /** One poll of an Azure-AsyncOperation or Location URL. */
  private async followed(ctx: CallContext, url: string): Promise<'pending' | 'succeeded' | { error: string; code?: string }> {
    const r = await this.send<{ status?: string; error?: { code?: string; message?: string } }>(ctx, 'GET', url);
    if (r.status === 202) return 'pending';
    if (r.status >= 400) return { error: r.body.error?.message ?? `Azure answered ${r.status}.`, ...(r.body.error?.code ? { code: r.body.error.code } : {}) };
    const st = (r.body.status ?? 'Succeeded').toLowerCase();
    if (st === 'succeeded') return 'succeeded';
    if (st === 'failed' || st === 'canceled') return { error: r.body.error?.message ?? `The operation ${st}.`, ...(r.body.error?.code ? { code: r.body.error.code } : {}) };
    return 'pending';
  }

  // ---------- virtual machines (B-10204) ----------

  vmId(ctx: CallContext, spec: { name: string }): string {
    return `${this.base(ctx)}/Microsoft.Compute/virtualMachines/${this.armName(ctx, spec)}`;
  }

  async describeVm(ctx: CallContext, ref: ResourceRef): Promise<ObservedResource | null> {
    const r = await this.send<AzVm>(ctx, 'GET', `${ref.providerId}?api-version=${API.compute}`);
    if (r.status === 404) return null;
    if (r.status >= 300) throw this.fail(r, 'the virtual machine');
    return vmObserved(r.body, ref.providerId);
  }

  async listVms(ctx: CallContext, managedOnly: boolean): Promise<ObservedResource[]> {
    const r = await this.send<{ value?: AzVm[] }>(ctx, 'GET', `${this.base(ctx)}/Microsoft.Compute/virtualMachines?api-version=${API.compute}`);
    if (r.status === 404) return [];
    if (r.status >= 300) throw this.fail(r, 'the virtual machines');
    return (r.body.value ?? []).map((v) => vmObserved(v, v.id!)).filter((o) => !managedOnly || (o.tags['exprsn:managed'] === 'true' && o.tags['exprsn:account'] === ctx.account.name));
  }

  async putVm(ctx: CallContext, spec: ResourceSpec<'vm'>, existed: boolean, handle: (op: OperationHandle['op'], ref: ResourceRef, kind: OperationHandle['kind'], token: string) => OperationHandle): Promise<OperationResult> {
    const p = spec.props;
    await this.h.ensureGroup(ctx, spec);
    const loc = this.h.location(ctx, spec);
    const refs = spec.parent?.refs ?? {};
    const subnet = p.subnet ? refs[p.subnet] : undefined;
    const nsg = p.firewall ? refs[p.firewall] : undefined;
    if (!subnet) throw new CloudProviderError('An Azure VM needs its subnet (props.subnet, created first).', 'azure', 400, 'parent_required');
    const name = this.armName(ctx, spec);
    const tags = { ...spec.tags, [NAME_TAG]: spec.name };
    const nicId = `${this.base(ctx)}/Microsoft.Network/networkInterfaces/${name}-nic`;
    const nic = await this.send(ctx, 'PUT', `${nicId}?api-version=${API.network}`, { location: loc, tags, properties: { ipConfigurations: [{ name: 'ipconfig1', properties: { subnet: { id: subnet }, privateIPAllocationMethod: 'Dynamic' } }], ...(nsg ? { networkSecurityGroup: { id: nsg } } : {}) } });
    if (nic.status >= 300) throw this.fail(nic, 'the network interface');
    const id = this.vmId(ctx, spec);
    // On an update the user data is not sent again: cloud-init ran at first boot, and a new release is a replace.
    const customData = existed ? undefined : await bootstrapUserData(p.userData, p.secrets, ctx.secrets);
    const body = {
      location: loc,
      tags,
      properties: {
        hardwareProfile: { vmSize: p.size },
        storageProfile: { imageReference: { publisher: 'Canonical', offer: 'ubuntu-24_04-lts', sku: 'server', version: 'latest' }, osDisk: { createOption: 'FromImage', managedDisk: { storageAccountType: 'Premium_LRS' }, deleteOption: 'Delete' } },
        osProfile: { computerName: name.slice(0, 63), adminUsername: 'exprsn', ...(customData ? { customData: Buffer.from(customData, 'utf8').toString('base64') } : {}), linuxConfiguration: { disablePasswordAuthentication: true, provisionVMAgent: true, ssh: { publicKeys: (p.sshKeys?.length ? p.sshKeys : [throwawaySshKey()]).map((keyData) => ({ path: '/home/exprsn/.ssh/authorized_keys', keyData })) } } },
        networkProfile: { networkInterfaces: [{ id: nicId, properties: { primary: true, deleteOption: 'Delete' } }] },
        diagnosticsProfile: { bootDiagnostics: { enabled: true } },
        securityProfile: { securityType: 'TrustedLaunch', uefiSettings: { secureBootEnabled: true, vTpmEnabled: true } }
      }
    };
    if (existed) delete (body.properties as { osProfile?: unknown }).osProfile;
    const r = await this.send<AzVm>(ctx, existed ? 'PATCH' : 'PUT', `${id}?api-version=${API.compute}`, existed ? { tags, properties: { hardwareProfile: body.properties.hardwareProfile } } : body);
    if (r.status >= 300) throw this.fail(r, 'the virtual machine');
    const ref: ResourceRef = { type: 'vm', providerId: id };
    const follow = this.followOf(r);
    const requestId = r.headers['x-ms-request-id'];
    if (follow) return { done: false, operation: handle(existed ? 'update' : 'create', ref, r.headers['azure-asyncoperation'] ? 'azure-async' : 'azure-location', follow), ...(requestId ? { requestId } : {}), ...(existed ? { adopted: true } : {}) };
    const o = vmObserved(r.body, id);
    return o.state === 'ready' ? { done: true, resource: o, ...(requestId ? { requestId } : {}) } : { done: false, operation: handle('create', ref, 'azure-location', `${id}?api-version=${API.compute}`), resource: o };
  }

  async deleteVm(ctx: CallContext, ref: ResourceRef, handle: (op: OperationHandle['op'], ref: ResourceRef, kind: OperationHandle['kind'], token: string) => OperationHandle): Promise<OperationResult> {
    const r = await this.send(ctx, 'DELETE', `${ref.providerId}?api-version=${API.compute}&forceDeletion=false`);
    if (r.status === 404 || r.status === 204 || r.status === 200) {
      await this.send(ctx, 'DELETE', `${ref.providerId.replace(/\/Microsoft\.Compute\/virtualMachines\/([^/]+)$/i, '/Microsoft.Network/networkInterfaces/$1-nic')}?api-version=${API.network}`).catch(() => null);
      return { done: true, resource: null };
    }
    if (r.status >= 300) throw this.fail(r, 'the virtual machine delete');
    const follow = this.followOf(r);
    return follow ? { done: false, operation: handle('delete', ref, r.headers['azure-asyncoperation'] ? 'azure-async' : 'azure-location', follow) } : { done: true, resource: null };
  }

  /** The installer's lines in the serial console log (boot diagnostics; the SAS URL is read without the ARM token). */
  async installStatus(ctx: CallContext, ref: ResourceRef): Promise<InstallStatus> {
    const r = await this.send<{ serialConsoleLogBlobUri?: string }>(ctx, 'POST', `${ref.providerId}/retrieveBootDiagnosticsData?api-version=${API.compute}&sasUriExpirationTimeInMinutes=10`);
    if (r.status === 404 || r.status === 409) return { state: 'unknown', detail: 'Boot diagnostics are not available yet.' };
    if (r.status >= 300) throw this.fail(r, 'the boot diagnostics');
    const uri = r.body.serialConsoleLogBlobUri;
    if (!uri) return { state: 'unknown', detail: 'The serial console log is not available yet.' };
    const u = new URL(uri);
    if (u.protocol !== 'https:' || !(u.hostname.endsWith('.blob.core.windows.net') || u.origin === new URL(this.h.arm()).origin)) throw new CloudProviderError(`Refusing a serial console URL outside Azure Storage (${u.host}).`, 'azure', 502, 'foreign_log_url');
    const log = await this.h.transport.send({ method: 'GET', url: u, headers: { 'x-ms-version': '2023-11-03' }, accountId: ctx.account.id, ...(ctx.signal ? { signal: ctx.signal } : {}) });
    if (log.status === 404) return { state: 'unknown', detail: 'The serial console log is empty so far.' };
    if (log.status >= 300) throw new CloudProviderError(`Azure Storage answered ${log.status} for the serial console log.`, 'azure', log.status, null, log.requestId);
    return installStatusFrom(log.body.toString('utf8'));
  }

  // ---------- Container Apps (B-10205) ----------

  private appIds(ctx: CallContext, spec: { name: string }) {
    const name = this.armName(ctx, spec).slice(0, 28).replace(/-+$/, '');
    const b = `${this.base(ctx)}/Microsoft.App`;
    return { app: `${b}/containerApps/${name}`, env: `${b}/managedEnvironments/${name}-env`, job: `${b}/jobs/${name.slice(0, 24)}-mig` };
  }

  async describeApp(ctx: CallContext, ref: ResourceRef): Promise<ObservedResource | null> {
    const r = await this.send<AzApp>(ctx, 'GET', `${ref.providerId}?api-version=${API.apps}`);
    if (r.status === 404) return null;
    if (r.status >= 300) throw this.fail(r, 'the container app');
    return appObserved(r.body, ref.providerId);
  }

  async findApp(ctx: CallContext, spec: ResourceSpec): Promise<ObservedResource | null> {
    return this.describeApp(ctx, { type: 'container_service', providerId: this.appIds(ctx, spec).app });
  }

  async listApps(ctx: CallContext, managedOnly: boolean): Promise<ObservedResource[]> {
    const r = await this.send<{ value?: AzApp[] }>(ctx, 'GET', `${this.base(ctx)}/Microsoft.App/containerApps?api-version=${API.apps}`);
    if (r.status === 404) return [];
    if (r.status >= 300) throw this.fail(r, 'the container apps');
    return (r.body.value ?? []).map((a) => appObserved(a, a.id!)).filter((o) => !managedOnly || (o.tags['exprsn:managed'] === 'true' && o.tags['exprsn:account'] === ctx.account.name));
  }

  /** The secrets as Container Apps secrets (values from the broker, straight to ARM) and the volume that mounts them as files. */
  private async secretsOf(ctx: CallContext, spec: ResourceSpec<'container_service'>) {
    const p = spec.props;
    if (p.secrets.length && !ctx.secrets) throw new CloudProviderError('No secret broker is configured, so the app’s secrets cannot be given to Container Apps.', 'azure', 409, 'secrets_unavailable');
    const secrets: { name: string; value: string }[] = [];
    for (const b of p.secrets) secrets.push({ name: fileName(b), value: await ctx.secrets!.value(b) });
    const volume = { name: 'secrets', storageType: 'Secret', secrets: p.secrets.map((b) => ({ secretRef: fileName(b), path: fileName(b) })) };
    return { secrets, volume, mount: { volumeName: 'secrets', mountPath: SECRET_MOUNT } };
  }

  private envOf(spec: ResourceSpec<'container_service'>) {
    const env = spec.props.env;
    if ('DATA_KEY' in env || 'DATA_KEY_PREVIOUS' in env) throw new CloudProviderError('DATA_KEY is never a Container Apps variable.', 'azure', 400, 'inline_secret');
    return Object.entries(env).map(([name, value]) => ({ name, value }));
  }

  /**
   * A rollout is a reconcile, one step per poll, read back from Azure each time (a journalled handle cannot change,
   * so nothing is remembered between polls but the spec and when the rollout started): the environment until it
   * is provisioned; the migration job put and started once (an execution that started after the rollout began is
   * this rollout's) and followed to `Succeeded`; then the app put with the new image and followed until its latest
   * revision is ready. A failed migration fails the step and the app is never put.
   */
  async rolloutApp(ctx: CallContext, spec: ResourceSpec<'container_service'>, op: 'create' | 'update', handle: (op: OperationHandle['op'], ref: ResourceRef, kind: OperationHandle['kind'], token: string) => OperationHandle): Promise<OperationResult> {
    if (!spec.props.image) throw new CloudProviderError('The container app has no image pinned by digest.', 'azure', 400, 'image_required');
    this.envOf(spec);
    if (spec.props.secrets.length && !ctx.secrets) throw new CloudProviderError('No secret broker is configured, so the app’s secrets cannot be given to Container Apps.', 'azure', 409, 'secrets_unavailable');
    await this.h.ensureGroup(ctx, spec);
    const ids = this.appIds(ctx, spec);
    await this.putEnv(ctx, spec);
    const { idempotencyKey: _k, ...kept } = spec;
    return { done: false, operation: handle(op, { type: 'container_service', providerId: ids.app }, 'azure-apps', JSON.stringify({ phase: 'rollout', op, spec: kept } satisfies AppsPhase)) };
  }

  private async putEnv(ctx: CallContext, spec: ResourceSpec<'container_service'>): Promise<void> {
    const ids = this.appIds(ctx, spec);
    const p = spec.props;
    const refs = spec.parent?.refs ?? {};
    const subnet = p.subnets.map((k) => refs[k]).find(Boolean);
    const env = await this.send(ctx, 'PUT', `${ids.env}?api-version=${API.apps}`, { location: this.h.location(ctx, spec), tags: { ...spec.tags, [NAME_TAG]: spec.name }, properties: { ...(subnet ? { vnetConfiguration: { infrastructureSubnetId: subnet, internal: p.ingress === 'internal' } } : {}), workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }], zoneRedundant: false } });
    if (env.status >= 300) throw this.fail(env, 'the Container Apps environment');
  }

  private async putJob(ctx: CallContext, spec: ResourceSpec<'container_service'>): Promise<void> {
    const ids = this.appIds(ctx, spec);
    const p = spec.props;
    const s = await this.secretsOf(ctx, spec);
    const job = await this.send(ctx, 'PUT', `${ids.job}?api-version=${API.apps}`, {
      location: this.h.location(ctx, spec),
      tags: { ...spec.tags, [NAME_TAG]: `${spec.name}-migrate` },
      properties: {
        environmentId: ids.env,
        configuration: { triggerType: 'Manual', replicaTimeout: 1800, replicaRetryLimit: 0, manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }, secrets: s.secrets },
        template: { containers: [{ name: 'migrate', image: p.image, command: p.migrate.command, env: this.envOf(spec), resources: { cpu: 0.5, memory: '1Gi' }, volumeMounts: [s.mount] }], volumes: [s.volume] }
      }
    });
    if (job.status >= 300) throw this.fail(job, 'the migration job');
    const start = await this.send(ctx, 'POST', `${ids.job}/start?api-version=${API.apps}`, {});
    if (start.status >= 300) throw this.fail(start, 'the migration job start');
  }

  private async putApp(ctx: CallContext, spec: ResourceSpec<'container_service'>, rollout: number): Promise<void> {
    const ids = this.appIds(ctx, spec);
    const p = spec.props;
    const s = await this.secretsOf(ctx, spec);
    const suffix = (p.version ?? '').replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 10);
    const r = await this.send<AzApp>(ctx, 'PUT', `${ids.app}?api-version=${API.apps}`, {
      location: this.h.location(ctx, spec),
      // `exprsn-rollout` (outside the managed `exprsn:` tags the planner compares) marks which rollout put it.
      tags: { ...spec.tags, [NAME_TAG]: spec.name, 'exprsn-rollout': String(rollout) },
      properties: {
        environmentId: ids.env,
        configuration: { activeRevisionsMode: 'Single', ingress: { external: p.ingress === 'internet-facing', targetPort: p.port, transport: 'auto', allowInsecure: false }, secrets: s.secrets },
        template: {
          ...(suffix ? { revisionSuffix: `r${suffix}` } : {}),
          containers: [{ name: 'app', image: p.image, env: this.envOf(spec), resources: { cpu: Math.min(p.vcpu, 4), memory: `${Math.min(p.memoryGb, 8)}Gi` }, volumeMounts: [s.mount], probes: [{ type: 'Readiness', httpGet: { path: '/readyz', port: p.port } }, { type: 'Liveness', httpGet: { path: '/healthz', port: p.port } }] }],
          scale: { minReplicas: p.replicas, maxReplicas: p.replicas * 2 },
          volumes: [s.volume]
        }
      }
    });
    if (r.status >= 300) throw this.fail(r, 'the container app');
  }

  /** One reconcile step of a rollout, or one poll of a delete. */
  async pollApps(ctx: CallContext, h: OperationHandle): Promise<PollResult> {
    const ph = JSON.parse(h.token) as AppsPhase;
    if (ph.phase === 'delete') {
      const r = await this.followed(ctx, ph.follow!);
      return r === 'pending' ? { state: 'pending', waitMs: 3000 } : r === 'succeeded' ? { state: 'succeeded', resource: null } : { state: 'failed', error: r.error, ...(r.code ? { code: r.code } : {}) };
    }
    const spec = { ...ph.spec!, idempotencyKey: '' } as ResourceSpec<'container_service'>;
    const ids = this.appIds(ctx, spec);
    // 1. The environment.
    const env = await this.send<{ properties?: { provisioningState?: string } }>(ctx, 'GET', `${ids.env}?api-version=${API.apps}`);
    if (env.status === 404) {
      await this.putEnv(ctx, spec);
      return { state: 'pending', waitMs: 5000, progress: 10 };
    }
    const envState = stateOf(env.body.properties?.provisioningState);
    if (envState === 'failed') return { state: 'failed', error: 'The Container Apps environment failed to provision.', code: 'environment_failed' };
    if (envState !== 'ready') return { state: 'pending', waitMs: 5000, progress: 20 };
    // 2. The migration: this rollout's execution, started once.
    const execs = await this.send<{ value?: { name?: string; properties?: { status?: string; startTime?: string } }[] }>(ctx, 'GET', `${ids.job}/executions?api-version=${API.apps}`);
    const mine = execs.status < 300 ? (execs.body.value ?? []).filter((e) => Date.parse(e.properties?.startTime ?? '') >= h.startedAt - 1000).sort((a, b) => Date.parse(b.properties!.startTime!) - Date.parse(a.properties!.startTime!))[0] : undefined;
    if (!mine) {
      await this.putJob(ctx, spec);
      return { state: 'pending', waitMs: 5000, progress: 30 };
    }
    const st = (mine.properties?.status ?? 'Running').toLowerCase();
    if (st === 'running' || st === 'processing' || st === 'unknown') return { state: 'pending', waitMs: 5000, progress: 45 };
    if (st !== 'succeeded') return { state: 'failed', error: `The migration job ended ${st}; the app was not rolled out.`, code: 'migration_failed' };
    // 3. The app with the new image, until its latest revision is ready.
    const raw = await this.send<AzApp>(ctx, 'GET', `${h.ref.providerId}?api-version=${API.apps}`);
    if (raw.status >= 300 && raw.status !== 404) throw this.fail(raw, 'the container app');
    if (raw.status === 404 || raw.body.tags?.['exprsn-rollout'] !== String(h.startedAt)) {
      await this.putApp(ctx, spec, h.startedAt);
      return { state: 'pending', waitMs: 3000, progress: 70 };
    }
    const o = appObserved(raw.body, h.ref.providerId);
    if (o.state === 'failed') return { state: 'failed', error: 'The container app’s revision failed to provision.', code: 'revision_failed' };
    return o.state === 'ready' ? { state: 'succeeded', resource: o } : { state: 'pending', waitMs: 3000, progress: 85 };
  }

  async deleteApp(ctx: CallContext, ref: ResourceRef, handle: (op: OperationHandle['op'], ref: ResourceRef, kind: OperationHandle['kind'], token: string) => OperationHandle): Promise<OperationResult> {
    const app = ref.providerId;
    const env = app.replace(/\/containerApps\/([^/]+)$/i, '/managedEnvironments/$1-env');
    const job = app.replace(/\/containerApps\/([^/]+)$/i, (_m, n: string) => `/jobs/${n.slice(0, 24)}-mig`);
    for (const id of [app, job]) {
      const r = await this.send(ctx, 'DELETE', `${id}?api-version=${API.apps}`);
      if (r.status >= 300 && r.status !== 404) throw this.fail(r, 'the container app delete');
    }
    const r = await this.send(ctx, 'DELETE', `${env}?api-version=${API.apps}`);
    if (r.status === 404 || r.status === 200 || r.status === 204) return { done: true, resource: null };
    if (r.status >= 300) throw this.fail(r, 'the Container Apps environment delete');
    const follow = this.followOf(r);
    return follow ? { done: false, operation: handle('delete', ref, 'azure-apps', JSON.stringify({ phase: 'delete', op: 'create', follow } satisfies AppsPhase)) } : { done: true, resource: null };
  }
}

interface AzVm { id?: string; name?: string; location?: string; tags?: Record<string, string>; properties?: { provisioningState?: string; hardwareProfile?: { vmSize?: string }; networkProfile?: { networkInterfaces?: { id?: string }[] }; securityProfile?: { securityType?: string } } }
interface AzApp { id?: string; name?: string; location?: string; tags?: Record<string, string>; properties?: { provisioningState?: string; latestRevisionName?: string; latestReadyRevisionName?: string; runningStatus?: string; configuration?: { ingress?: { fqdn?: string; external?: boolean } }; template?: { containers?: { image?: string }[]; scale?: { minReplicas?: number } } } }

const stateOf = (p: string | undefined): ObservedResource['state'] => {
  const s = (p ?? 'Succeeded').toLowerCase();
  return s === 'succeeded' ? 'ready' : s === 'failed' || s === 'canceled' ? 'failed' : s === 'deleting' ? 'deleting' : s === 'updating' ? 'updating' : 'creating';
};

function vmObserved(v: AzVm, id: string): ObservedResource {
  return { type: 'vm', providerId: v.id ?? id, name: v.tags?.[NAME_TAG] ?? v.name ?? id.split('/').pop()!, ...(v.location ? { region: v.location } : {}), state: stateOf(v.properties?.provisioningState), tags: managed(v.tags), props: { size: v.properties?.hardwareProfile?.vmSize, publicIp: false, trustedLaunch: v.properties?.securityProfile?.securityType === 'TrustedLaunch', status: v.properties?.provisioningState } };
}

function appObserved(a: AzApp, id: string): ObservedResource {
  const p = a.properties ?? {};
  const revisionReady = !p.latestRevisionName || p.latestRevisionName === p.latestReadyRevisionName;
  const st = stateOf(p.provisioningState);
  return {
    type: 'container_service',
    providerId: a.id ?? id,
    name: a.tags?.[NAME_TAG] ?? a.name ?? id.split('/').pop()!,
    ...(a.location ? { region: a.location } : {}),
    state: st === 'ready' && !revisionReady ? 'updating' : st,
    tags: managed(a.tags),
    props: { platform: 'container-apps', image: p.template?.containers?.[0]?.image ?? null, replicas: p.template?.scale?.minReplicas ?? null, address: p.configuration?.ingress?.fqdn ?? null, revision: p.latestReadyRevisionName ?? null }
  };
}
