import { ulid } from 'ulid';
import { actorFrom } from '../audit/chain.js';
import type { Label } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import { json } from '../db/knex.js';
import { loadPrincipal } from '../http/middleware.js';
import { badRequest, conflict, HttpProblem, notFound } from '../http/problem.js';
import type { JobContext } from '../platform/jobs.js';
import type { Services } from '../services.js';
import { emptyGraph, graphSchema } from '../workflows/graph.js';
import { AppPackages, STAGES, type ApplyReport, type AppPackage, type PackageRow, type Stage } from './packages.js';
import { appView, type Actor, type AppRow, type AppService } from './service.js';

/*
 * Environments and promotion (1.6.0, Sprint 39b, B-8202, B-8203): a pipeline gives an app three stages, each an app
 * slot of its own (development, test, production; usually in three workspaces), and moves one package through them:
 *
 * - a promotion to test packages the development app as it is now (a new version) and deploys it onto the test app;
 * - a promotion to production deploys the exact package the last successful promotion to test landed (its hash is
 *   on the deployment), never a fresh one, and never from development: a stage cannot be skipped;
 * - production waits for an approval: the pipeline names a published workflow with an approval step, a run of it
 *   starts with the deployment as its input and as its caller (`caller_kind: app-deployment`), and the deployment
 *   proceeds when the run succeeds and is rejected when it fails, is rejected or expires;
 * - before a package is applied, the target app's design is packaged as a backup (`source: backup`); a rollback is a
 *   deployment of that backup onto the same stage, with its own backup, so a rollback can itself be undone;
 * - every deployment is a row of the history (source, target, version, who, state, report), kept
 *   APPS_DEPLOYMENT_HISTORY_DAYS, and audited `app.package.promoted`, `app.package.rolled_back` or
 *   `app.package.deployment.failed`.
 */

export type DeploymentState = 'awaiting-approval' | 'queued' | 'running' | 'succeeded' | 'failed' | 'rejected';
export const CALLER_KIND = 'app-deployment';

export interface PipelineRow {
  id: string;
  tenant_id: string;
  name: string;
  dev_app_id: string;
  test_app_id: string;
  prod_app_id: string;
  approval_workflow_id: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface DeploymentRow {
  id: string;
  tenant_id: string;
  pipeline_id: string;
  kind: 'promotion' | 'rollback';
  from_stage: Stage | null;
  to_stage: Stage;
  package_id: string;
  version: number;
  source_app_id: string | null;
  target_app_id: string;
  backup_package_id: string | null;
  state: DeploymentState;
  approval_run_id: string | null;
  rollback_of: string | null;
  report: string | null;
  error: string | null;
  job_id: string | null;
  created_by: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

const num = (v: unknown) => (v == null ? null : Number(v));
const pipelineFrom = (r: Record<string, unknown>): PipelineRow => ({ ...(r as unknown as PipelineRow), created_at: Number(r.created_at), updated_at: Number(r.updated_at) });
const deploymentFrom = (r: Record<string, unknown>): DeploymentRow => ({ ...(r as unknown as DeploymentRow), created_at: Number(r.created_at), started_at: num(r.started_at), finished_at: num(r.finished_at) });

export interface PipelineInput {
  name: string;
  development: string;
  test: string;
  production: string;
  approvalWorkflow?: string | null;
}

export class AppPipelines {
  constructor(
    private readonly s: () => Services,
    private readonly apps: AppService,
    private readonly packages: AppPackages
  ) {}

  private get db() {
    return this.s().db;
  }

  registerJobs(): void {
    this.s().jobs.register('apps.deploy', (p, ctx) => this.runDeployment(String(p.deploymentId), ctx), { timeoutMs: 60 * 60_000 });
  }

  private audit(actor: Actor, tenantId: string, action: string, target: Record<string, unknown>, label?: Label, detail?: Record<string, unknown>) {
    const who = actor.principal ? actorFrom(actor.principal, actor.ip ?? null) : { service: actor.service ?? 'apps' };
    return this.s().audit.append({ tenantId, action, kind: actor.principal ? 'admin' : 'system', actor: who, target, ...(label ? { label } : {}), ...(detail ? { detail } : {}), traceId: actor.traceId ?? null });
  }

  // ---------- pipelines ----------

  private stageApp(row: PipelineRow, stage: Stage): string {
    return stage === 'development' ? row.dev_app_id : stage === 'test' ? row.test_app_id : row.prod_app_id;
  }

  private async row(tenantId: string, id: string): Promise<PipelineRow> {
    const r = (await this.db('app_pipelines').where({ tenant_id: tenantId, id }).first()) as Record<string, unknown> | undefined;
    if (!r) throw notFound('Pipeline');
    return pipelineFrom(r);
  }

  /** A pipeline the caller may see: every stage's app is visible to them (its label caps nothing here). */
  async get(p: Principal, id: string): Promise<PipelineRow> {
    const row = await this.row(p.tenantId, id);
    for (const stage of STAGES) await this.apps.app(p, this.stageApp(row, stage)).catch(() => Promise.reject(notFound('Pipeline')));
    return row;
  }

  async list(p: Principal): Promise<PipelineRow[]> {
    const rows = ((await this.db('app_pipelines').where({ tenant_id: p.tenantId }).orderBy('name')) as Record<string, unknown>[]).map(pipelineFrom);
    const out: PipelineRow[] = [];
    for (const r of rows) {
      let ok = true;
      for (const stage of STAGES) if (!(await this.apps.app(p, this.stageApp(r, stage)).catch(() => null))) ok = false;
      if (ok) out.push(r);
    }
    return out;
  }

  /** The approval workflow must be published and carry an approval step. Returns its id. */
  private async checkApprovalWorkflow(p: Principal, ref: string | null | undefined): Promise<string | null> {
    if (!ref) return null;
    const s = this.s();
    const w = await s.workflows.workflow(p, ref);
    if (!w.published_version) throw conflict(`${w.name} has no published version; publish it before it guards a stage.`);
    const v = (await s.db('workflow_versions').where({ workflow_id: w.id, version: w.published_version }).first('graph')) as { graph: unknown } | undefined;
    const graph = graphSchema.safeParse(json(v?.graph, emptyGraph()));
    if (!graph.success || !graph.data.nodes.some((n) => n.kind === 'approval')) throw conflict(`${w.name} has no approval step; a production promotion waits on one.`);
    return w.id;
  }

  private async checkStages(actor: Actor & { principal: Principal }, input: Pick<PipelineInput, 'development' | 'test' | 'production'>): Promise<{ dev: AppRow; test: AppRow; prod: AppRow }> {
    const dev = await this.apps.designable(actor.principal, input.development);
    const test = await this.apps.designable(actor.principal, input.test);
    const prod = await this.apps.designable(actor.principal, input.production);
    if (new Set([dev.id, test.id, prod.id]).size !== 3) throw badRequest('The three stages are three different apps.');
    return { dev, test, prod };
  }

  async create(actor: Actor & { principal: Principal }, input: PipelineInput): Promise<PipelineRow> {
    const p = actor.principal;
    const { dev, test, prod } = await this.checkStages(actor, input);
    const approval = await this.checkApprovalWorkflow(p, input.approvalWorkflow);
    const t = Date.now();
    const row: PipelineRow = { id: ulid(), tenant_id: p.tenantId, name: input.name, dev_app_id: dev.id, test_app_id: test.id, prod_app_id: prod.id, approval_workflow_id: approval, created_by: p.userId, updated_by: p.userId, created_at: t, updated_at: t };
    if (await this.db('app_pipelines').where({ tenant_id: p.tenantId, name: input.name }).first('id')) throw conflict(`A pipeline named ${input.name} exists.`);
    await this.db('app_pipelines').insert(row);
    await this.audit(actor, p.tenantId, 'app.pipeline.created', { pipeline: row.id, name: row.name }, undefined, { development: dev.name, test: test.name, production: prod.name, approvalWorkflow: approval });
    return row;
  }

  async update(actor: Actor & { principal: Principal }, id: string, patch: Partial<PipelineInput>): Promise<PipelineRow> {
    const p = actor.principal;
    const row = await this.get(p, id);
    const stages = await this.checkStages(actor, { development: patch.development ?? row.dev_app_id, test: patch.test ?? row.test_app_id, production: patch.production ?? row.prod_app_id });
    const approval = patch.approvalWorkflow === undefined ? row.approval_workflow_id : await this.checkApprovalWorkflow(p, patch.approvalWorkflow);
    const next: PipelineRow = { ...row, name: patch.name ?? row.name, dev_app_id: stages.dev.id, test_app_id: stages.test.id, prod_app_id: stages.prod.id, approval_workflow_id: approval, updated_by: p.userId, updated_at: Date.now() };
    if (next.name !== row.name && (await this.db('app_pipelines').where({ tenant_id: p.tenantId, name: next.name }).first('id'))) throw conflict(`A pipeline named ${next.name} exists.`);
    await this.db('app_pipelines').where({ id }).update({ name: next.name, dev_app_id: next.dev_app_id, test_app_id: next.test_app_id, prod_app_id: next.prod_app_id, approval_workflow_id: next.approval_workflow_id, updated_by: next.updated_by, updated_at: next.updated_at });
    await this.audit(actor, p.tenantId, 'app.pipeline.updated', { pipeline: id, name: next.name }, undefined, { development: stages.dev.name, test: stages.test.name, production: stages.prod.name, approvalWorkflow: approval });
    return next;
  }

  async remove(actor: Actor & { principal: Principal }, id: string): Promise<void> {
    const p = actor.principal;
    const row = await this.get(p, id);
    if (await this.db('app_deployments').where({ pipeline_id: id }).whereIn('state', ['awaiting-approval', 'queued', 'running']).first('id')) throw conflict('A deployment of this pipeline is still going.');
    await this.db('app_deployments').where({ pipeline_id: id }).delete();
    await this.db('app_pipelines').where({ id }).delete();
    await this.audit(actor, p.tenantId, 'app.pipeline.deleted', { pipeline: id, name: row.name });
  }

  async view(p: Principal, row: PipelineRow) {
    const stage = async (id: string) => {
      const app = await this.apps.appById(p.tenantId, id);
      return app ? { ...appView(app), entities: undefined } : { id, name: '(deleted)', title: '(deleted)' };
    };
    const last = async (to: Stage) => {
      const d = (await this.db('app_deployments').where({ pipeline_id: row.id, to_stage: to, state: 'succeeded' }).orderBy('finished_at', 'desc').first()) as Record<string, unknown> | undefined;
      return d ? this.deploymentView(deploymentFrom(d), new Map()) : null;
    };
    const w = row.approval_workflow_id ? ((await this.db('workflows').where({ id: row.approval_workflow_id }).first('id', 'name')) as { id: string; name: string } | undefined) : undefined;
    const active = (await this.db('app_deployments').where({ pipeline_id: row.id }).whereIn('state', ['awaiting-approval', 'queued', 'running']).first('id')) as { id: string } | undefined;
    return {
      id: row.id,
      name: row.name,
      stages: { development: await stage(row.dev_app_id), test: await stage(row.test_app_id), production: await stage(row.prod_app_id) },
      approvalWorkflow: w ? { id: w.id, name: w.name } : null,
      last: { test: await last('test'), production: await last('production') },
      activeDeployment: active?.id ?? null,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  // ---------- deployments ----------

  private async deployment(tenantId: string, id: string): Promise<DeploymentRow> {
    const r = (await this.db('app_deployments').where({ tenant_id: tenantId, id }).first()) as Record<string, unknown> | undefined;
    if (!r) throw notFound('Deployment');
    return deploymentFrom(r);
  }

  deploymentView(d: DeploymentRow, names: Map<string, string>) {
    return {
      id: d.id,
      pipelineId: d.pipeline_id,
      kind: d.kind,
      from: d.from_stage,
      to: d.to_stage,
      packageId: d.package_id,
      version: d.version,
      sourceAppId: d.source_app_id,
      targetAppId: d.target_app_id,
      backupPackageId: d.backup_package_id,
      state: d.state,
      approvalRunId: d.approval_run_id,
      rollbackOf: d.rollback_of,
      report: AppPackages.report(d.report),
      error: d.error,
      createdBy: d.created_by,
      createdByName: (d.created_by && names.get(d.created_by)) ?? null,
      createdAt: d.created_at,
      startedAt: d.started_at,
      finishedAt: d.finished_at
    };
  }

  private async names(ids: (string | null)[]): Promise<Map<string, string>> {
    const want = [...new Set(ids.filter((x): x is string => !!x))];
    if (!want.length) return new Map();
    const rows = (await this.db('users').whereIn('id', want).select('id', 'display_name', 'username')) as { id: string; display_name: string | null; username: string }[];
    return new Map(rows.map((u) => [u.id, u.display_name || u.username]));
  }

  /** The history of a pipeline, newest first, after rows past APPS_DEPLOYMENT_HISTORY_DAYS are dropped. */
  async history(p: Principal, pipelineId: string, limit = 100) {
    const row = await this.get(p, pipelineId);
    const cutoff = Date.now() - this.s().cfg.APPS_DEPLOYMENT_HISTORY_DAYS * 86_400_000;
    await this.db('app_deployments').where({ tenant_id: p.tenantId, pipeline_id: row.id }).whereIn('state', ['succeeded', 'failed', 'rejected']).andWhere('created_at', '<', cutoff).delete();
    const rows = ((await this.db('app_deployments').where({ tenant_id: p.tenantId, pipeline_id: row.id }).orderBy('created_at', 'desc').limit(Math.min(Math.max(1, limit), 500))) as Record<string, unknown>[]).map(deploymentFrom);
    const names = await this.names(rows.map((d) => d.created_by));
    return rows.map((d) => this.deploymentView(d, names));
  }

  async deploymentFor(p: Principal, id: string) {
    const d = await this.deployment(p.tenantId, id);
    await this.get(p, d.pipeline_id);
    return this.deploymentView(d, await this.names([d.created_by]));
  }

  private async insertDeployment(d: DeploymentRow): Promise<void> {
    await this.db('app_deployments').insert(d);
  }

  private async enqueue(d: DeploymentRow, by: string | null): Promise<void> {
    const job = await this.s().jobs.enqueue({ tenantId: d.tenant_id, type: 'apps.deploy', payload: { deploymentId: d.id }, createdBy: by ?? undefined, maxAttempts: 1 });
    await this.db('app_deployments').where({ id: d.id }).update({ state: 'queued', job_id: job.id });
  }

  /** Promotes the pipeline's package one stage: development → test (a new package), test → production (the tested one). */
  async promote(actor: Actor & { principal: Principal }, pipelineId: string, input: { to: 'test' | 'production'; note?: string | null }) {
    const p = actor.principal;
    const row = await this.get(p, pipelineId);
    for (const stage of STAGES) await this.apps.designable(p, this.stageApp(row, stage));
    if (await this.db('app_deployments').where({ pipeline_id: row.id }).whereIn('state', ['awaiting-approval', 'queued', 'running']).first('id')) throw conflict('A deployment of this pipeline is still going; wait for it.');
    const t = Date.now();
    let d: DeploymentRow;
    if (input.to === 'test') {
      const dev = await this.apps.app(p, row.dev_app_id);
      const { row: pkg } = await this.packages.create(actor, dev, { withData: false, note: input.note ?? `promotion to test of ${row.name}`, source: 'promotion' });
      d = { id: ulid(), tenant_id: p.tenantId, pipeline_id: row.id, kind: 'promotion', from_stage: 'development', to_stage: 'test', package_id: pkg.id, version: pkg.version, source_app_id: dev.id, target_app_id: row.test_app_id, backup_package_id: null, state: 'queued', approval_run_id: null, rollback_of: null, report: null, error: null, job_id: null, created_by: p.userId, created_at: t, started_at: null, finished_at: null };
      await this.insertDeployment(d);
      await this.audit(actor, p.tenantId, 'app.package.promotion.requested', { pipeline: row.id, deployment: d.id, package: pkg.id }, undefined, { from: 'development', to: 'test', version: pkg.version, hash: pkg.hash });
      await this.enqueue(d, p.userId);
      return this.deploymentFor(p, d.id);
    }
    // Production takes the exact package the last successful promotion to test landed. A stage cannot be skipped.
    const tested = (await this.db('app_deployments').where({ pipeline_id: row.id, to_stage: 'test', state: 'succeeded' }).orderBy('finished_at', 'desc').first()) as Record<string, unknown> | undefined;
    if (!tested) throw conflict('Nothing has passed test yet: promote to test first.');
    const testedRow = deploymentFrom(tested);
    const pkg = await this.packages.row(p.tenantId, testedRow.package_id);
    if (!row.approval_workflow_id) throw conflict('A promotion to production needs an approval: name a workflow with an approval step on the pipeline.');
    d = { id: ulid(), tenant_id: p.tenantId, pipeline_id: row.id, kind: 'promotion', from_stage: 'test', to_stage: 'production', package_id: pkg.id, version: pkg.version, source_app_id: row.test_app_id, target_app_id: row.prod_app_id, backup_package_id: null, state: 'awaiting-approval', approval_run_id: null, rollback_of: null, report: null, error: null, job_id: null, created_by: p.userId, created_at: t, started_at: null, finished_at: null };
    await this.insertDeployment(d);
    const prod = await this.apps.appById(p.tenantId, row.prod_app_id);
    try {
      const run = await this.s().workflows.start(p, row.approval_workflow_id, {
        input: { kind: 'app-deployment', deployment: d.id, pipeline: row.name, from: 'test', to: 'production', app: prod?.name ?? row.prod_app_id, package: { id: pkg.id, version: pkg.version, hash: pkg.hash }, note: input.note ?? null, requestedBy: p.username },
        dry: false,
        trigger: 'api:app-deployment',
        caller: { kind: CALLER_KIND, id: d.id, node: 'approval' }
      });
      await this.db('app_deployments').where({ id: d.id }).update({ approval_run_id: run.id });
      d.approval_run_id = run.id;
    } catch (err) {
      await this.db('app_deployments').where({ id: d.id }).update({ state: 'failed', error: `The approval workflow could not start: ${(err as Error).message}`.slice(0, 1000), finished_at: Date.now() });
      throw err;
    }
    await this.audit(actor, p.tenantId, 'app.package.promotion.requested', { pipeline: row.id, deployment: d.id, package: pkg.id, run: d.approval_run_id }, undefined, { from: 'test', to: 'production', version: pkg.version, hash: pkg.hash, approvalWorkflow: row.approval_workflow_id });
    return this.deploymentFor(p, d.id);
  }

  /** The approval run ended (`caller_kind: app-deployment`): a success deploys, anything else rejects. */
  async approvalDone(tenantId: string, deploymentId: string): Promise<void> {
    const d = await this.deployment(tenantId, deploymentId).catch(() => null);
    if (!d || d.state !== 'awaiting-approval' || !d.approval_run_id) return;
    const run = (await this.db('workflow_runs').where({ id: d.approval_run_id }).first('state', 'error')) as { state: string; error: string | null } | undefined;
    if (!run || !['succeeded', 'failed', 'rejected', 'cancelled'].includes(run.state)) return;
    if (run.state === 'succeeded') {
      await this.audit({ service: 'apps' } as Actor, tenantId, 'app.package.promotion.approved', { pipeline: d.pipeline_id, deployment: d.id, package: d.package_id, run: d.approval_run_id }, undefined, { to: d.to_stage, version: d.version });
      await this.enqueue(d, d.created_by);
      return;
    }
    const error = run.state === 'succeeded' ? null : `The approval run ${run.state}${run.error ? `: ${run.error}` : ''}`.slice(0, 1000);
    await this.db('app_deployments').where({ id: d.id, state: 'awaiting-approval' }).update({ state: 'rejected', error, finished_at: Date.now() });
    await this.audit({ service: 'apps' } as Actor, tenantId, 'app.package.promotion.rejected', { pipeline: d.pipeline_id, deployment: d.id, package: d.package_id, run: d.approval_run_id }, undefined, { to: d.to_stage, version: d.version, reason: error });
    if (d.created_by) await this.s().notifications.notify({ tenantId, userIds: [d.created_by], kind: 'workflow', title: 'Promotion to production rejected', body: error ?? 'The approval was not given.', route: 'apps' });
  }

  /** Undoes a succeeded deployment: deploys the backup taken before it onto the same stage. */
  async rollback(actor: Actor & { principal: Principal }, deploymentId: string, note: string | null = null) {
    const p = actor.principal;
    const d = await this.deployment(p.tenantId, deploymentId);
    const row = await this.get(p, d.pipeline_id);
    await this.apps.designable(p, d.target_app_id);
    if (d.state !== 'succeeded') throw conflict(`Only a deployment that succeeded can be rolled back; this one ${d.state}.`);
    if (!d.backup_package_id) throw conflict('This deployment kept no backup to roll back to.');
    if (await this.db('app_deployments').where({ pipeline_id: row.id }).whereIn('state', ['awaiting-approval', 'queued', 'running']).first('id')) throw conflict('A deployment of this pipeline is still going; wait for it.');
    const backup = await this.packages.row(p.tenantId, d.backup_package_id);
    const r: DeploymentRow = { id: ulid(), tenant_id: p.tenantId, pipeline_id: row.id, kind: 'rollback', from_stage: null, to_stage: d.to_stage, package_id: backup.id, version: backup.version, source_app_id: null, target_app_id: d.target_app_id, backup_package_id: null, state: 'queued', approval_run_id: null, rollback_of: d.id, report: null, error: null, job_id: null, created_by: p.userId, created_at: Date.now(), started_at: null, finished_at: null };
    await this.insertDeployment(r);
    await this.audit(actor, p.tenantId, 'app.package.rollback.requested', { pipeline: row.id, deployment: r.id, rollbackOf: d.id, package: backup.id }, undefined, { to: d.to_stage, version: backup.version, hash: backup.hash, note });
    await this.enqueue(r, p.userId);
    return this.deploymentFor(p, r.id);
  }

  /** The job: back the target up, apply the package, record the report. */
  async runDeployment(deploymentId: string, ctx: JobContext): Promise<unknown> {
    const s = this.s();
    const d = (await this.db('app_deployments').where({ id: deploymentId }).first()) as Record<string, unknown> | undefined;
    if (!d) return { skipped: 'missing' };
    const dep = deploymentFrom(d);
    if (dep.state !== 'queued') return { skipped: dep.state };
    const principal = dep.created_by ? await loadPrincipal(s, dep.tenant_id, dep.created_by, {}) : null;
    if (!principal) {
      await this.db('app_deployments').where({ id: dep.id }).update({ state: 'failed', error: 'The requester is no longer an active user.', finished_at: Date.now() });
      return { state: 'failed' };
    }
    const actor: Actor & { principal: Principal } = { principal, source: 'api', traceId: `job:${ctx.job.id}` };
    await this.db('app_deployments').where({ id: dep.id }).update({ state: 'running', started_at: Date.now() });
    const label = (await this.apps.appById(dep.tenant_id, dep.target_app_id))?.label;
    try {
      const target = await this.apps.designable(principal, dep.target_app_id);
      // The deployment acts in the target's workspace: the workflows its triggers name are looked up there.
      principal.workspaceId = target.workspace_id ?? principal.workspaceId ?? null;
      await ctx.progress(10, 'Backing the target up');
      const backup = await this.packages.create(actor, target, { withData: false, note: `backup before deployment ${dep.id}`, source: 'backup' });
      await this.db('app_deployments').where({ id: dep.id }).update({ backup_package_id: backup.row.id });
      await ctx.progress(30, 'Applying the package');
      const { pkg } = await this.packages.open(dep.tenant_id, dep.package_id);
      const report: ApplyReport = await this.packages.apply(actor, pkg, target, { mode: 'deploy' });
      await this.db('app_deployments').where({ id: dep.id }).update({ state: 'succeeded', report: JSON.stringify(report), finished_at: Date.now() });
      await this.audit(actor, dep.tenant_id, dep.kind === 'rollback' ? 'app.package.rolled_back' : 'app.package.promoted', { pipeline: dep.pipeline_id, deployment: dep.id, package: dep.package_id, app: target.id, name: target.name, backup: backup.row.id, ...(dep.rollback_of ? { rollbackOf: dep.rollback_of } : {}) }, label, { from: dep.from_stage, to: dep.to_stage, version: dep.version, hash: AppPackages.hashOf(pkg), entities: report.entities, forms: report.forms, triggers: { created: report.triggers.created, removed: report.triggers.removed, skipped: report.triggers.skipped.length }, policies: report.policies, workflows: report.workflows, records: report.records.created });
      await ctx.progress(100, 'Deployed');
      return { state: 'succeeded', report };
    } catch (err) {
      const error = (err instanceof HttpProblem ? err.detail : (err as Error).message)?.slice(0, 1000) ?? 'failed';
      await this.db('app_deployments').where({ id: dep.id }).update({ state: 'failed', error, finished_at: Date.now() });
      await this.audit(actor, dep.tenant_id, 'app.package.deployment.failed', { pipeline: dep.pipeline_id, deployment: dep.id, package: dep.package_id, app: dep.target_app_id }, label, { to: dep.to_stage, version: dep.version, error });
      if (dep.created_by) await s.notifications.notify({ tenantId: dep.tenant_id, userIds: [dep.created_by], kind: 'workflow', title: `Deployment to ${dep.to_stage} failed`, body: error, route: 'apps' }).catch(() => undefined);
      return { state: 'failed', error };
    }
  }

  /** For the Apps screen: the stage an app sits in, if any pipeline names it. */
  async stageOf(tenantId: string, appId: string): Promise<{ pipeline: string; name: string; stage: Stage } | null> {
    const r = (await this.db('app_pipelines').where({ tenant_id: tenantId }).andWhere((q) => q.where({ dev_app_id: appId }).orWhere({ test_app_id: appId }).orWhere({ prod_app_id: appId })).first()) as Record<string, unknown> | undefined;
    if (!r) return null;
    const row = pipelineFrom(r);
    return { pipeline: row.id, name: row.name, stage: row.dev_app_id === appId ? 'development' : row.test_app_id === appId ? 'test' : 'production' };
  }

  /** The package rows referenced by deployments, for the history's labels. */
  async packagesOf(tenantId: string, ids: string[]): Promise<Map<string, PackageRow>> {
    if (!ids.length) return new Map();
    const rows = (await this.db('app_packages').where({ tenant_id: tenantId }).whereIn('id', [...new Set(ids)]).select('id', 'tenant_id', 'app_id', 'app_name', 'version', 'format', 'source', 'hash', 'with_data', 'size', 'note', 'created_by', 'created_at')) as Record<string, unknown>[];
    return new Map(rows.map((r) => [String(r.id), { ...(r as unknown as PackageRow), with_data: !!r.with_data, created_at: Number(r.created_at), body: '' }]));
  }
}

export type { AppPackage };
