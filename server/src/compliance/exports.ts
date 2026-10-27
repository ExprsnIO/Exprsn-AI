import { ulid } from 'ulid';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { clears, highest, isLabel, labelRank, type Label } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import { json } from '../db/knex.js';
import { conflict, HttpProblem, notFound } from '../http/problem.js';
import type { JobContext } from '../platform/jobs.js';
import type { Services } from '../services.js';

/*
 * Compliance exports (1.6.0, B-7603): the conversations, files, memories, agent runs and users of one user or one
 * workspace over a date range, as JSON Lines for eDiscovery tools, written by a job and sealed with the tenant key in
 * parts in the blob store (like audit exports). The requester needs `compliance:export`: a person, or an API key
 * scoped to it (the scoped token an eDiscovery tool holds). Rows above the requester's clearance are left out and
 * counted (`omitted`); the export's label is the highest it carries, and only someone cleared for it downloads it.
 * Every request, run and download is audited; the people exported are not told.
 *
 * One line per object: `{kind: "conversation", ...}` with its messages (content opened, held and withdrawn ones as
 * their state), `{kind: "file"}` (metadata and version list; the bytes stay in the file store), `{kind: "memory"}`,
 * `{kind: "run"}` (input and output) and `{kind: "user"}`; a first line `{kind: "export"}` names the scope, and a last
 * `{kind: "summary"}` the counts.
 */

export const EXPORT_KINDS = ['conversations', 'files', 'memories', 'runs', 'users'] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];
export const EXPORT_JOB = 'compliance.export';
const PART_BYTES = 1024 * 1024;

export const exportInputSchema = z
  .object({
    userId: z.string().length(26).nullable().optional(),
    workspaceId: z.string().length(26).nullable().optional(),
    from: z.number().int().min(0),
    to: z.number().int().min(0),
    kinds: z.array(z.enum(EXPORT_KINDS)).min(1).default([...EXPORT_KINDS])
  })
  .strict()
  .refine((x) => x.userId || x.workspaceId, 'Name a user, a workspace, or both')
  .refine((x) => x.to >= x.from, 'to is before from');
export type ExportInput = z.infer<typeof exportInputSchema>;

export interface ComplianceExportRow {
  id: string;
  tenant_id: string;
  params: ExportInput;
  scope: string;
  state: 'queued' | 'running' | 'ready' | 'failed';
  max_label: Label;
  counts: Record<string, number> | null;
  omitted: number | null;
  blob_key: string | null;
  job_id: string | null;
  created_by: string;
  api_key_id: string | null;
  error: string | null;
  created_at: number;
  finished_at: number | null;
}

const fromRow = (r: Record<string, unknown>): ComplianceExportRow => ({ ...(r as unknown as ComplianceExportRow), params: json(r.params, {} as ExportInput), counts: json(r.counts, null), omitted: r.omitted == null ? null : Number(r.omitted), created_at: Number(r.created_at), finished_at: r.finished_at == null ? null : Number(r.finished_at) });

export const exportView = (x: ComplianceExportRow) => ({ id: x.id, params: x.params, scope: x.scope, state: x.state, label: x.max_label, counts: x.counts, omitted: x.omitted, createdBy: x.created_by, apiKeyId: x.api_key_id, error: x.error, createdAt: x.created_at, finishedAt: x.finished_at, file: `compliance-${x.id.slice(-8).toLowerCase()}.jsonl` });

class ExportMissing extends Error {}

export class ComplianceExports {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  registerJobs(): void {
    this.s().jobs.register(EXPORT_JOB, (p, ctx) => this.run(String(p.exportId), ctx), { timeoutMs: 60 * 60_000 });
  }

  private partKey(x: ComplianceExportRow, n: number): string {
    return `compliance/${x.tenant_id}/${x.id}/part-${String(n).padStart(5, '0')}.sealed`;
  }

  async list(p: Principal): Promise<ComplianceExportRow[]> {
    return ((await this.db('compliance_exports').where({ tenant_id: p.tenantId }).orderBy('created_at', 'desc').limit(100)) as Record<string, unknown>[]).map(fromRow);
  }

  async get(tenantId: string, id: string): Promise<ComplianceExportRow> {
    const r = await this.db('compliance_exports').where({ tenant_id: tenantId, id }).first();
    if (!r) throw notFound('Export');
    return fromRow(r);
  }

  /** Queues an export; the job writes it. Audited `compliance.export.requested`. */
  async request(p: Principal, ip: string | null, input: ExportInput): Promise<ComplianceExportRow> {
    const s = this.s();
    const maxDays = s.cfg.COMPLIANCE_EXPORT_MAX_DAYS;
    if (maxDays && input.to - input.from > maxDays * 86_400_000) throw new HttpProblem(400, 'Range too long', `An export covers at most ${maxDays} days (COMPLIANCE_EXPORT_MAX_DAYS).`, { extensions: { maxDays } });
    const user = input.userId ? await s.users.get(p.tenantId, input.userId) : null;
    if (input.userId && !user) throw notFound('User');
    const ws = input.workspaceId ? await s.tenants.workspace(p.tenantId, input.workspaceId) : null;
    if (input.workspaceId && !ws) throw notFound('Workspace');
    const day = (t: number) => new Date(t).toISOString().slice(0, 10);
    const scope = [user ? `user ${user.username}` : null, ws ? `workspace ${ws.name}` : null].filter(Boolean).join(', ') + `, ${day(input.from)} to ${day(input.to)}, ${input.kinds.join(' ')}`;
    const id = ulid();
    const t = Date.now();
    await this.db('compliance_exports').insert({ id, tenant_id: p.tenantId, params: JSON.stringify(input), scope: scope.slice(0, 300), state: 'queued', max_label: 'public', counts: null, omitted: null, blob_key: null, job_id: null, created_by: p.userId, api_key_id: p.apiKeyId, error: null, created_at: t, finished_at: null });
    const job = await s.jobs.enqueue({ tenantId: p.tenantId, type: EXPORT_JOB, payload: { exportId: id }, createdBy: p.userId, maxAttempts: 2 });
    await this.db('compliance_exports').where({ id }).update({ job_id: job.id });
    await s.audit.append({ tenantId: p.tenantId, action: 'compliance.export.requested', kind: 'admin', actor: actorFrom(p, ip), target: { export: id, ...(input.userId ? { user: input.userId } : {}), ...(input.workspaceId ? { workspace: input.workspaceId } : {}) }, detail: { from: input.from, to: input.to, kinds: input.kinds, viaApiKey: !!p.apiKeyId } });
    return this.get(p.tenantId, id);
  }

  /** The export's lines, one sealed part at a time. */
  async *parts(x: ComplianceExportRow): AsyncGenerator<Buffer> {
    if (!x.blob_key) return;
    const s = this.s();
    const manifest = await s.blobs.get(x.blob_key);
    if (!manifest) throw new ExportMissing();
    const { parts } = JSON.parse(manifest.toString('utf8')) as { parts: number };
    for (let n = 0; n < parts; n++) {
      const sealed = await s.blobs.get(this.partKey(x, n));
      if (!sealed) throw new ExportMissing();
      yield await s.keys.openBytes(x.tenant_id, sealed.toString('utf8'), `compliance-export:${x.id}:${n}`);
    }
  }

  /** The whole export (tests and small downloads). Null when its parts are missing. */
  async content(x: ComplianceExportRow): Promise<Buffer | null> {
    const out: Buffer[] = [];
    try {
      for await (const part of this.parts(x)) out.push(part);
    } catch (err) {
      if (err instanceof ExportMissing) return null;
      throw err;
    }
    return x.blob_key ? Buffer.concat(out) : null;
  }

  /** Streams a ready export to a requester cleared for it. Audited `compliance.export.downloaded`. */
  async download(p: Principal, ip: string | null, id: string): Promise<{ file: string; parts: AsyncGenerator<Buffer>; first: Buffer | null }> {
    const x = await this.get(p.tenantId, id);
    if (x.state !== 'ready') throw conflict(`The export is ${x.state}.`);
    if (!clears(p.clearance, x.max_label)) throw new HttpProblem(403, 'Above your clearance', `This export holds ${x.max_label} content; your clearance is ${p.clearance}.`, { extensions: { step: 'clearance' } });
    const parts = this.parts(x);
    let first: IteratorResult<Buffer>;
    try {
      first = await parts.next();
    } catch {
      throw notFound('Export file');
    }
    await this.s().audit.append({ tenantId: p.tenantId, action: 'compliance.export.downloaded', kind: 'admin', actor: actorFrom(p, ip), target: { export: x.id }, label: x.max_label, detail: { counts: x.counts, viaApiKey: !!p.apiKeyId } });
    return { file: exportView(x).file, parts, first: first.done ? null : first.value };
  }

  // ---------- the job ----------

  private writer(x: ComplianceExportRow) {
    const s = this.s();
    let buf: string[] = [];
    let size = 0;
    let parts = 0;
    const flush = async () => {
      if (!buf.length) return;
      const sealed = await s.keys.sealBytes(x.tenant_id, Buffer.from(buf.join(''), 'utf8'), `compliance-export:${x.id}:${parts}`);
      await s.blobs.put(this.partKey(x, parts), Buffer.from(sealed, 'utf8'), 'application/octet-stream');
      parts++;
      buf = [];
      size = 0;
    };
    return {
      line: async (obj: Record<string, unknown>) => {
        const l = JSON.stringify(obj) + '\n';
        buf.push(l);
        size += l.length;
        if (size >= PART_BYTES) await flush();
      },
      finish: async (): Promise<string> => {
        await flush();
        const key = `compliance/${x.tenant_id}/${x.id}/manifest.json`;
        await s.blobs.put(key, Buffer.from(JSON.stringify({ parts }), 'utf8'), 'application/json');
        return key;
      }
    };
  }

  private async run(id: string, ctx: JobContext): Promise<unknown> {
    const s = this.s();
    const raw = await this.db('compliance_exports').where({ id }).first();
    if (!raw) return { skipped: 'gone' };
    const x = fromRow(raw);
    if (x.state === 'ready') return { skipped: 'ready' };
    await this.db('compliance_exports').where({ id }).update({ state: 'running' });
    const requester = await s.users.get(x.tenant_id, x.created_by);
    const clearance: Label = requester && isLabel(requester.clearance) ? requester.clearance : 'public';
    const { userId, workspaceId, from, to, kinds } = x.params;
    const max = s.cfg.COMPLIANCE_EXPORT_MAX_ROWS;
    const counts: Record<string, number> = { conversations: 0, messages: 0, files: 0, memories: 0, runs: 0, users: 0 };
    let omitted = 0;
    let maxLabel: Label = 'public';
    let rows = 0;
    const out = this.writer(x);
    const tooMany = () => new Error(`More than ${max} rows match (COMPLIANCE_EXPORT_MAX_ROWS); narrow the range.`);
    const scoped = (q: ReturnType<typeof this.db>, userCol: string, wsCol: string | null) => {
      q.where((w) => {
        if (userId) w.where(userCol, userId);
        if (workspaceId && wsCol) w.orWhere(wsCol, workspaceId);
      });
      if (!userId && workspaceId && !wsCol) q.whereRaw('1 = 0');
      return q;
    };
    const admit = (label: unknown): boolean => {
      const l = isLabel(label) ? label : 'internal';
      if (!clears(clearance, l)) {
        omitted++;
        return false;
      }
      maxLabel = highest(maxLabel, l);
      return true;
    };
    const open = async (field: string, oid: string, sealed: unknown): Promise<string | null> => (sealed == null ? null : ((await s.keys.open(x.tenant_id, String(sealed), `${field}:${oid}`)) ?? null));
    try {
      await out.line({ kind: 'export', id: x.id, tenant: x.tenant_id, userId: userId ?? null, workspaceId: workspaceId ?? null, from, to, kinds, requestedBy: x.created_by, requestedAt: x.created_at, clearance });
      if (kinds.includes('conversations')) {
        const convs = (await scoped(this.db('conversations').where({ tenant_id: x.tenant_id }).whereBetween('created_at', [from, to]), 'user_id', 'workspace_id').orderBy('created_at').limit(max + 1)) as Record<string, unknown>[];
        if (convs.length > max) throw tooMany();
        for (const c of convs) {
          if (!admit(c.label)) continue;
          const msgs = (await this.db('messages').where({ conversation_id: String(c.id) }).orderBy([{ column: 'created_at' }, { column: 'id' }]).limit(10_000)) as Record<string, unknown>[];
          const messages = [];
          for (const m of msgs) {
            if (!admit(m.label)) continue;
            const hidden = m.state === 'held' || m.state === 'withdrawn' || m.state === 'hidden';
            messages.push({ id: m.id, role: m.role, state: m.state, label: m.label, parentId: m.parent_id, profile: m.profile_name, model: m.model, createdAt: Number(m.created_at), content: await open('content', String(m.id), m.content), thinking: hidden ? null : await open('thinking', String(m.id), m.thinking), attachments: json<string[]>(m.attachments, []), guard: json(m.guard, null) });
          }
          await out.line({ kind: 'conversation', id: c.id, userId: c.user_id, workspaceId: c.workspace_id, title: await open('title', String(c.id), c.title), label: c.label, conversationKind: c.kind, createdAt: Number(c.created_at), updatedAt: Number(c.updated_at), archivedAt: c.archived_at == null ? null : Number(c.archived_at), messages });
          counts.conversations!++;
          counts.messages! += messages.length;
          if ((rows += 1 + messages.length) > max) throw tooMany();
        }
        await ctx.progress(20, `${counts.conversations} conversations`);
      }
      if (kinds.includes('files')) {
        const files = (await scoped(this.db('files').where({ tenant_id: x.tenant_id }).whereBetween('created_at', [from, to]), 'owner_id', 'workspace_id').orderBy('created_at').limit(max + 1)) as Record<string, unknown>[];
        if (files.length > max) throw tooMany();
        for (const f of files) {
          if (!admit(f.label)) continue;
          const versions = (await this.db('file_versions').where({ file_id: String(f.id) }).orderBy('number').select('number', 'state', 'size', 'sha256', 'type', 'label', 'created_by', 'created_at')) as Record<string, unknown>[];
          await out.line({ kind: 'file', id: f.id, name: f.name, type: f.type, label: f.label, state: f.state, ownerId: f.owner_id, workspaceId: f.workspace_id, folderId: f.folder_id, currentVersion: f.current_version == null ? null : Number(f.current_version), createdAt: Number(f.created_at), updatedAt: Number(f.updated_at), trashedAt: f.trashed_at == null ? null : Number(f.trashed_at), versions: versions.map((v) => ({ ...v, size: Number(v.size), number: Number(v.number), created_at: Number(v.created_at) })) });
          counts.files!++;
          if (++rows > max) throw tooMany();
        }
        await ctx.progress(40, `${counts.files} files`);
      }
      if (kinds.includes('memories')) {
        const q = this.db('memories').where({ tenant_id: x.tenant_id }).whereBetween('created_at', [from, to]).where((w) => {
          if (userId) w.where({ scope: 'user', owner_id: userId });
          if (workspaceId) w.orWhere({ scope: 'workspace', owner_id: workspaceId });
        });
        const mems = (await q.orderBy('created_at').limit(max + 1)) as Record<string, unknown>[];
        if (mems.length > max) throw tooMany();
        for (const m of mems) {
          if (!admit(m.label)) continue;
          await out.line({ kind: 'memory', id: m.id, scope: m.scope, ownerId: m.owner_id, type: m.type, state: m.state, label: m.label, text: await open('memory', String(m.id), m.content), source: json(m.source, null), authorId: m.author_id, createdAt: Number(m.created_at), updatedAt: Number(m.updated_at), expiresAt: m.expires_at == null ? null : Number(m.expires_at) });
          counts.memories!++;
          if (++rows > max) throw tooMany();
        }
        await ctx.progress(60, `${counts.memories} memories`);
      }
      if (kinds.includes('runs')) {
        const runs = (await scoped(this.db('agent_runs').where({ tenant_id: x.tenant_id }).whereBetween('created_at', [from, to]), 'user_id', 'workspace_id').orderBy('created_at').limit(max + 1)) as Record<string, unknown>[];
        if (runs.length > max) throw tooMany();
        for (const r of runs) {
          if (!admit(r.label)) continue;
          await out.line({ kind: 'run', id: r.id, userId: r.user_id, workspaceId: r.workspace_id, agent: r.agent_name, agentVersion: r.agent_version == null ? null : Number(r.agent_version), profile: r.profile, state: r.state, label: r.label, input: await open('agent-run-input', String(r.id), r.input), output: await open('agent-run-output', String(r.id), r.output), error: r.error, usage: json(r.usage, null), createdAt: Number(r.created_at), finishedAt: r.finished_at == null ? null : Number(r.finished_at) });
          counts.runs!++;
          if (++rows > max) throw tooMany();
        }
        await ctx.progress(80, `${counts.runs} runs`);
      }
      if (kinds.includes('users')) {
        const ids = new Set<string>();
        if (userId) ids.add(userId);
        if (workspaceId) for (const m of (await this.db('workspace_members').where({ workspace_id: workspaceId }).select('user_id')) as { user_id: string }[]) ids.add(m.user_id);
        const users = ids.size ? ((await this.db('users').where({ tenant_id: x.tenant_id }).whereIn('id', [...ids].slice(0, max)).orderBy('username')) as Record<string, unknown>[]) : [];
        for (const u of users) {
          await out.line({ kind: 'user', id: u.id, username: u.username, displayName: u.display_name, email: u.email, state: u.state, clearance: u.clearance, roles: await s.users.roleIds(String(u.id)), createdAt: Number(u.created_at), lastLoginAt: u.last_login_at == null ? null : Number(u.last_login_at) });
          counts.users!++;
          if (++rows > max) throw tooMany();
        }
      }
      await out.line({ kind: 'summary', counts, omitted, label: maxLabel });
      const key = await out.finish();
      const t = Date.now();
      await this.db('compliance_exports').where({ id }).update({ state: 'ready', max_label: maxLabel, counts: JSON.stringify(counts), omitted, blob_key: key, finished_at: t });
      await s.audit.append({ tenantId: x.tenant_id, action: 'compliance.exported', kind: 'system', actor: { service: 'compliance', user: x.created_by }, target: { export: x.id, ...(userId ? { user: userId } : {}), ...(workspaceId ? { workspace: workspaceId } : {}) }, label: maxLabel, detail: { counts, omitted, from, to, kinds } });
      await ctx.progress(100, 'written');
      return { counts, omitted };
    } catch (err) {
      const message = String((err as Error).message ?? err).slice(0, 500);
      await this.db('compliance_exports').where({ id }).update({ state: 'failed', error: message, finished_at: Date.now() });
      await s.audit.append({ tenantId: x.tenant_id, action: 'compliance.export.failed', kind: 'system', actor: { service: 'compliance', user: x.created_by }, target: { export: x.id }, detail: { error: message } });
      throw err;
    }
  }
}

export const isAboveClearance = (clearance: Label, label: Label): boolean => labelRank(label) > labelRank(clearance);
