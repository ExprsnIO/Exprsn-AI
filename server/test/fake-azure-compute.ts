/*
 * 1.9.99-final, Sprint 58 (B-10204, B-10205): the compute part of the Azure fake (`fake-azure.ts` routes to it). The
 * generic ARM store already keeps network interfaces, virtual machines, managed environments, container apps and
 * jobs by path; this adds what is not a plain PUT or GET: a VM's `retrieveBootDiagnosticsData` and the serial console
 * log behind its SAS URL (the simulated first boot of `fake-vm-boot.ts`, from the VM's `customData`), a job's `start`
 * and its executions (Running, then Succeeded or the status a test sets), and a container app's revisions and FQDN.
 * It is never the real Azure.
 */
import { randomUUID } from 'node:crypto';
import { simulateBoot } from './fake-vm-boot.js';
import type { RecordedRequest, Reply } from './fake-cloud-base.js';

interface Execution { id: string; name: string; job: string; status: string; polls: number; startTime: string; command: unknown }

export interface AzureComputeHelpers {
  resource(key: string): { id: string; name: string; body: Record<string, unknown> } | undefined;
  origin(): string;
  settleAfter(): number;
}

export class FakeAzureCompute {
  /** URL → sha256 of what that URL serves (a tampered tarball has another digest). */
  releases = new Map<string, string>();
  readonly executions = new Map<string, Execution>();
  /** How the next migration job executions end. */
  migrationStatus: 'Succeeded' | 'Failed' = 'Succeeded';

  constructor(private readonly h: AzureComputeHelpers) {}

  /** The serial console log path (outside ARM, read without a bearer token, as a SAS URL is). */
  static readonly LOG_PREFIX = '/exprsn-bootdiag/';

  serialLog(r: RecordedRequest): Reply {
    const vmKey = decodeURIComponent(r.path.slice(FakeAzureCompute.LOG_PREFIX.length).replace(/\/serial\.log$/, ''));
    if (!r.query.get('sig')) return { status: 403, body: 'AuthenticationFailed' };
    const vm = this.h.resource(vmKey.toLowerCase());
    if (!vm) return { status: 404, body: 'BlobNotFound' };
    const custom = ((vm.body.properties as { osProfile?: { customData?: string } } | undefined)?.osProfile?.customData) ?? null;
    return { status: 200, headers: { 'content-type': 'text/plain' }, body: simulateBoot(custom ? Buffer.from(custom, 'base64').toString('utf8') : null, this.releases).console };
  }

  /** POST actions the generic store does not know. */
  post(r: RecordedRequest): Reply | null {
    const lower = r.path.toLowerCase();
    let m = /^(.*\/providers\/microsoft\.compute\/virtualmachines\/[^/]+)\/retrievebootdiagnosticsdata$/.exec(lower);
    if (m) {
      const vm = this.h.resource(m[1]!);
      if (!vm) return { status: 404, body: { error: { code: 'ResourceNotFound', message: 'The virtual machine was not found.' } } };
      return { status: 200, body: { consoleScreenshotBlobUri: null, serialConsoleLogBlobUri: `${this.h.origin()}${FakeAzureCompute.LOG_PREFIX}${encodeURIComponent(m[1]!)}/serial.log?sv=2023-11-03&sig=fake` } };
    }
    m = /^(.*\/providers\/microsoft\.app\/jobs\/([^/]+))\/start$/.exec(lower);
    if (m) {
      const job = this.h.resource(m[1]!);
      if (!job) return { status: 404, body: { error: { code: 'ResourceNotFound', message: 'The job was not found.' } } };
      const name = `${m[2]}-${randomUUID().slice(0, 7)}`;
      const e: Execution = { id: `${job.id}/executions/${name}`, name, job: m[1]!, status: 'Running', polls: 0, startTime: new Date().toISOString(), command: (job.body.properties as { template?: { containers?: { command?: unknown }[] } })?.template?.containers?.[0]?.command };
      this.executions.set(name, e);
      return { status: 202, body: { id: e.id, name } };
    }
    return null;
  }

  /** GETs of job executions. */
  get(r: RecordedRequest): Reply | null {
    const lower = r.path.toLowerCase();
    const m = /^(.*\/providers\/microsoft\.app\/jobs\/[^/]+)\/executions(?:\/([^/]+))?$/.exec(lower);
    if (!m) return null;
    const view = (e: Execution) => {
      e.polls += 1;
      if (e.status === 'Running' && e.polls > this.h.settleAfter()) e.status = this.migrationStatus;
      return { id: e.id, name: e.name, type: 'Microsoft.App/jobs/executions', properties: { status: e.status, startTime: e.startTime } };
    };
    if (m[2]) {
      const e = [...this.executions.values()].find((x) => x.name.toLowerCase() === m[2]);
      return e ? { status: 200, body: view(e) } : { status: 404, body: { error: { code: 'ResourceNotFound', message: 'The execution was not found.' } } };
    }
    return { status: 200, body: { value: [...this.executions.values()].filter((x) => x.job === m[1]).map(view) } };
  }

  /** What Azure adds to a container app it provisions: the revision and the ingress FQDN. */
  decorate(lowerType: string, path: string, props: Record<string, unknown>): void {
    if (lowerType !== 'microsoft.app/containerapps') return;
    const name = path.split('/').pop()!;
    const suffix = (props.template as { revisionSuffix?: string } | undefined)?.revisionSuffix ?? randomUUID().slice(0, 7);
    const revision = `${name}--${suffix}`;
    const ingress = ((props.configuration as { ingress?: Record<string, unknown> } | undefined)?.ingress ?? {}) as Record<string, unknown>;
    Object.assign(props, { latestRevisionName: revision, latestReadyRevisionName: revision, runningStatus: 'Running', configuration: { ...(props.configuration as object), ingress: { ...ingress, fqdn: `${name}.${ingress.external ? '' : 'internal.'}purplesea-1234.westeurope.azurecontainerapps.io` } } });
  }
}
