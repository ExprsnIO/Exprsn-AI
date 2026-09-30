import { ulid } from 'ulid';
import type { Db } from '../db/knex.js';
import { json } from '../db/knex.js';
import { LABELS, labelRank, type Label } from '../authz/labels.js';
import type { BlobStore } from '../platform/blob.js';
import type { DataKeys } from '../platform/datakeys.js';
import type { JobQueue } from '../platform/jobs.js';
import { dayOf, dayToDate } from '../tenancy/quotas.js';
import { rowToEvent, type AuditLog, type AuditQuery } from './chain.js';


/** Plain-text size at which an export part is sealed and written. */
const PART_BYTES = 1024 * 1024;
const partKey = (e: { tenant_id: string; id: string }, n: number) => `exports/${e.tenant_id}/${e.id}/part-${String(n).padStart(5, '0')}.sealed`;
class ExportMissing extends Error {}

export interface ExportRow {
  id: string;
  tenant_id: string;
  kind: 'audit' | 'usage';
  file: string;
  params: Record<string, unknown>;
  scope: string;
  max_label: Label;
  state: 'queued' | 'running' | 'ready' | 'failed';
  rows: number | null;
  omitted: number | null;
  blob_key: string | null;
  job_id: string | null;
  created_by: string;
  created_at: number;
}

const fromRow = (r: Record<string, unknown>): ExportRow => ({ ...(r as unknown as ExportRow), params: json(r.params, {}), rows: r.rows == null ? null : Number(r.rows), omitted: r.omitted == null ? null : Number(r.omitted), created_at: Number(r.created_at) });

/** RFC 4180 field, with spreadsheet formula injection defused. */
export function csvField(v: unknown): string {
  let s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
export const csvLine = (fields: unknown[]): string => fields.map(csvField).join(',') + '\r\n';

const labelsUpTo = (l: Label): Label[] => LABELS.filter((x) => labelRank(x) <= labelRank(l));
const iso = (ts: number) => new Date(ts).toISOString();

/**
 * CSV exports of audit events and usage, produced by a job, sealed with the tenant key in the blob store.
 * An audit export never contains a row above the requester's clearance: a request that would is refused with the
 * count, and the requester may ask for the filtered export instead.
 */
export class ExportService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditLog,
    private readonly blobs: BlobStore,
    private readonly keys: DataKeys,
    private readonly jobs: JobQueue
  ) {
    jobs.register('export.audit', (p, ctx) => this.runAudit(String(p.exportId), ctx.progress));
    jobs.register('export.usage', (p, ctx) => this.runUsage(String(p.exportId), ctx.progress));
  }

  /** Counts audit rows in the selection above a clearance. */
  async auditAbove(tenantId: string, q: AuditQuery, clearance: Label): Promise<{ total: number; above: number }> {
    const [t] = await this.audit.query(tenantId, q).count({ n: '*' });
    const [a] = await this.audit.query(tenantId, q).whereNotIn('label', labelsUpTo(clearance)).count({ n: '*' });
    return { total: Number(t?.n ?? 0), above: Number(a?.n ?? 0) };
  }

  async request(input: { tenantId: string; tenantSlug: string; kind: 'audit' | 'usage'; params: Record<string, unknown>; scope: string; maxLabel: Label; userId: string }): Promise<ExportRow> {
    const id = ulid();
    const stamp = new Date().toISOString().slice(0, 10);
    const row: ExportRow = {
      id,
      tenant_id: input.tenantId,
      kind: input.kind,
      file: `${input.kind}-${input.tenantSlug}-${stamp}-${id.slice(-6).toLowerCase()}.csv`,
      params: input.params,
      scope: input.scope.slice(0, 300),
      max_label: input.maxLabel,
      state: 'queued',
      rows: null,
      omitted: null,
      blob_key: null,
      job_id: null,
      created_by: input.userId,
      created_at: Date.now()
    };
    await this.db('exports').insert({ ...row, params: JSON.stringify(row.params) });
    const job = await this.jobs.enqueue({ tenantId: input.tenantId, type: `export.${input.kind}`, payload: { exportId: id }, createdBy: input.userId });
    await this.db('exports').where({ id }).update({ job_id: job.id });
    return { ...row, job_id: job.id };
  }

  async get(tenantId: string, id: string): Promise<ExportRow | undefined> {
    const r = await this.db('exports').where({ tenant_id: tenantId, id }).first();
    return r ? fromRow(r) : undefined;
  }

  async list(tenantId: string, limit = 50): Promise<ExportRow[]> {
    return (await this.db('exports').where({ tenant_id: tenantId }).orderBy('created_at', 'desc').limit(limit)).map(fromRow);
  }

  /** The decrypted file, one sealed part at a time (null when it is missing), so a download never holds it all. */
  async *parts(e: ExportRow): AsyncGenerator<Buffer> {
    if (!e.blob_key) return;
    if (e.blob_key.endsWith('.csv.sealed')) {
      // Exports written before parts: one sealed object.
      const sealed = await this.blobs.get(e.blob_key);
      if (!sealed) throw new ExportMissing();
      yield await this.keys.openBytes(e.tenant_id, sealed.toString('utf8'), `export:${e.id}`);
      return;
    }
    const manifest = await this.blobs.get(e.blob_key);
    if (!manifest) throw new ExportMissing();
    const { parts } = JSON.parse(manifest.toString('utf8')) as { parts: number };
    for (let n = 0; n < parts; n++) {
      const sealed = await this.blobs.get(partKey(e, n));
      if (!sealed) throw new ExportMissing();
      yield await this.keys.openBytes(e.tenant_id, sealed.toString('utf8'), `export:${e.id}:${n}`);
    }
  }

  async content(e: ExportRow): Promise<Buffer | null> {
    const out: Buffer[] = [];
    try {
      for await (const part of this.parts(e)) out.push(part);
    } catch (err) {
      if (err instanceof ExportMissing) return null;
      throw err;
    }
    return e.blob_key ? Buffer.concat(out) : null;
  }

  /** Writes CSV lines as sealed parts of about PART_BYTES each, so the export is never held in memory whole. */
  private writer(e: ExportRow) {
    let buf: string[] = [];
    let size = 0;
    let parts = 0;
    const flush = async () => {
      if (!buf.length) return;
      const sealed = await this.keys.sealBytes(e.tenant_id, Buffer.from(buf.join(''), 'utf8'), `export:${e.id}:${parts}`);
      await this.blobs.put(partKey(e, parts), Buffer.from(sealed, 'utf8'), 'application/octet-stream');
      parts++;
      buf = [];
      size = 0;
    };
    return {
      line: async (cells: unknown[]) => {
        const l = csvLine(cells);
        buf.push(l);
        size += l.length;
        if (size >= PART_BYTES) await flush();
      },
      finish: async (rows: number, omitted: number): Promise<{ rows: number; omitted: number }> => {
        await flush();
        const key = `exports/${e.tenant_id}/${e.id}/manifest.json`;
        await this.blobs.put(key, Buffer.from(JSON.stringify({ parts }), 'utf8'), 'application/json');
        await this.db('exports').where({ id: e.id }).update({ state: 'ready', rows, omitted, blob_key: key });
        return { rows, omitted };
      }
    };
  }

  private async load(id: string): Promise<ExportRow> {
    const r = await this.db('exports').where({ id }).first();
    if (!r) throw new Error(`Export ${id} not found`);
    await this.db('exports').where({ id }).update({ state: 'running' });
    return fromRow(r);
  }

  private async runAudit(id: string, progress: (pct: number, m?: string) => Promise<void>): Promise<unknown> {
    const e = await this.load(id);
    try {
      const q = e.params as AuditQuery;
      const allowed = labelsUpTo(e.max_label);
      const { total, above } = await this.auditAbove(e.tenant_id, q, e.max_label);
      const out = this.writer(e);
      await out.line(['seq', 'id', 'time', 'kind', 'action', 'actor_user', 'actor_username', 'actor_name', 'actor_service', 'target', 'label', 'decision', 'detail', 'trace_id', 'corrects', 'prev_hash', 'hash']);
      let rows = 0;
      let after = 0;
      for (;;) {
        const page = await this.audit.query(e.tenant_id, q).whereIn('label', allowed).andWhere('seq', '>', after).orderBy('seq', 'asc').limit(1000);
        for (const raw of page) {
          const ev = rowToEvent(raw);
          await out.line([ev.seq, ev.id, iso(ev.ts), ev.kind, ev.action, ev.actor.user, ev.actor.username, ev.actor.name, ev.actor.service, ev.target, ev.label, ev.decision, ev.detail, ev.trace_id, ev.corrects, ev.prev_hash, ev.hash]);
          after = ev.seq;
          rows++;
        }
        await progress(total ? (rows / Math.max(1, total - above)) * 95 : 95, `${rows} rows`);
        if (page.length < 1000) break;
      }
      return await out.finish(rows, above);
    } catch (err) {
      await this.db('exports').where({ id }).update({ state: 'failed' });
      throw err;
    }
  }

  private async runUsage(id: string, progress: (pct: number, m?: string) => Promise<void>): Promise<unknown> {
    const e = await this.load(id);
    try {
      const p = e.params as { from?: number; to?: number; workspaceId?: string };
      const from = p.from ?? dayOf(Date.now() - 30 * 86_400_000);
      const to = p.to ?? dayOf(Date.now());
      const q = this.db('usage_records as r')
        .leftJoin('users as u', 'u.id', 'r.user_id')
        .leftJoin('workspaces as w', 'w.id', 'r.workspace_id')
        .where('r.tenant_id', e.tenant_id)
        .whereBetween('r.day', [from, to]);
      if (p.workspaceId) q.andWhere('r.workspace_id', p.workspaceId);
      const rows = await q
        .groupBy('r.day', 'w.name', 'u.username', 'r.model', 'r.kind')
        .select('r.day', 'w.name as workspace', 'u.username', 'r.model', 'r.kind')
        .sum({ prompt: 'r.prompt_tokens', output: 'r.output_tokens', thinking: 'r.thinking_tokens', calc: 'r.calc_calls', gpu: 'r.gpu_ms' })
        .count({ requests: '*' })
        .orderBy('r.day');
      const out = this.writer(e);
      await out.line(['day', 'workspace', 'user', 'model', 'kind', 'prompt_tokens', 'output_tokens', 'thinking_tokens', 'calc_calls', 'gpu_seconds', 'requests']);
      for (const r of rows as Record<string, unknown>[]) {
        await out.line([dayToDate(Number(r.day)), r.workspace, r.username, r.model, r.kind, Number(r.prompt ?? 0), Number(r.output ?? 0), Number(r.thinking ?? 0), Number(r.calc ?? 0), (Number(r.gpu ?? 0) / 1000).toFixed(1), Number(r.requests ?? 0)]);
      }
      await progress(95, `${rows.length} rows`);
      return await out.finish(rows.length, 0);
    } catch (err) {
      await this.db('exports').where({ id }).update({ state: 'failed' });
      throw err;
    }
  }
}
