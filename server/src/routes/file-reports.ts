import { Readable } from 'node:stream';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { highest, labelRank, type Label } from '../authz/labels.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../http/middleware.js';
import { HttpProblem } from '../http/problem.js';
import { FileReports, REPORT_KINDS, renderReport, type ReportKind } from '../files/reports.js';
import { fileView, versionView } from '../files/service.js';
import type { Services } from '../services.js';
import { nameSchema, sendFile } from './files.js';

const id26 = z.string().length(26);
const scopeQuery = z.object({ workspace: id26.optional(), folder: id26.optional() });
const kindParam = z.enum(REPORT_KINDS);

/** The lower of two labels. */
const lowest = (a: Label, b: Label): Label => (labelRank(a) <= labelRank(b) ? a : b);

/**
 * 2.0.0 (file management): reports and the dashboard of a workspace's files or a folder's (`files/reports.ts`).
 * Reading needs `files:read` as a member of the workspace; saving a report as a file needs `files:write`. Every export
 * and every save is audited.
 */
export function fileReportRoutes(s: Services): Router {
  const r = Router();
  r.use('/file-reports', noStore, requireAuth());
  const read = requirePermission(s, 'files:read');
  const write = requirePermission(s, 'files:write');
  const reports = new FileReports(() => s);

  const audit = (req: Request, action: string, target: Record<string, unknown>, label: Label, detail: Record<string, unknown>) => {
    const p = principalOf(req);
    return s.audit.append({ tenantId: p.tenantId, action, kind: 'admin', actor: actorFrom(p, ip(req)), target, label, detail, traceId: req.traceId });
  };

  r.get('/file-reports/summary', read, async (req, res) => {
    const q = parseBody(scopeQuery, req.query);
    res.json(await reports.summary(principalOf(req), { workspaceId: q.workspace ?? null, folderId: q.folder ?? null }));
  });

  r.get('/file-reports/:kind', read, async (req, res) => {
    const kind = parseBody(kindParam, req.params.kind) as ReportKind;
    const q = parseBody(scopeQuery.extend({ format: z.enum(['json', 'csv', 'xlsx']).default('json') }), req.query);
    const p = principalOf(req);
    const report = await reports.report(p, { workspaceId: q.workspace ?? null, folderId: q.folder ?? null }, kind);
    if (q.format === 'json') {
      res.json(report);
      return;
    }
    const out = renderReport(report, q.format);
    await audit(req, 'file.report.exported', { workspace: report.scope.workspaceId, ...(report.scope.folderId ? { folder: report.scope.folderId } : {}) }, report.label, { report: kind, format: q.format, rows: report.rows.length, truncated: report.truncated });
    await sendFile(res, { name: out.name, type: out.type, size: out.data.length, stream: Readable.from([out.data]) });
  });

  r.post('/file-reports/:kind/save', write, async (req, res) => {
    const kind = parseBody(kindParam, req.params.kind) as ReportKind;
    const body = parseBody(z.object({ workspaceId: id26.optional(), folderId: id26.nullable().optional(), targetFolderId: id26.nullable().optional(), format: z.enum(['csv', 'xlsx']).default('csv'), name: nameSchema.optional() }).strict(), req.body ?? {});
    const p = principalOf(req);
    const report = await reports.report(p, { workspaceId: body.workspaceId ?? null, folderId: body.folderId ?? null }, kind);
    const out = renderReport(report, body.format);
    const ws = await s.files.workspaceFor(p, report.scope.workspaceId);
    // Never below what the report lists; otherwise internal, within the workspace's ceiling and the caller's clearance.
    const label = highest(report.label, lowest(lowest('internal', ws.label_ceiling), p.clearance));
    const ext = `.${body.format}`;
    let base = body.name ?? out.name;
    if (!base.toLowerCase().endsWith(ext)) base += ext;
    const stem = base.slice(0, -ext.length);
    const targetFolder = body.targetFolderId !== undefined ? body.targetFolderId : report.scope.folderId;
    let saved: Awaited<ReturnType<typeof s.files.upload>> | null = null;
    for (let i = 1; i <= 50 && !saved; i++) {
      const name = i === 1 ? base : `${stem} (${i})${ext}`;
      try {
        saved = await s.files.upload(p, { workspaceId: ws.id, folderId: targetFolder ?? null, name, label, declaredType: out.type, declaredBytes: out.data.length }, Readable.from([out.data]));
      } catch (err) {
        if (!(err instanceof HttpProblem && err.status === 409 && /already/.test(err.detail ?? ''))) throw err;
      }
    }
    if (!saved) throw new HttpProblem(409, 'Conflict', `Too many files named like ${base} in this folder; give the report a name.`);
    const { file, version } = saved;
    await audit(req, 'file.report.saved', { file: file.id, version: version.number, workspace: file.workspace_id, ...(report.scope.folderId ? { folder: report.scope.folderId } : {}) }, version.label, { report: kind, format: body.format, rows: report.rows.length, truncated: report.truncated, name: file.name, size: version.size });
    res.status(202).json({ ...fileView(file), version: versionView(version), report: { kind, rows: report.rows.length, truncated: report.truncated } });
  });

  return r;
}

