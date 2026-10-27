import { Router, type Request } from 'express';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { LABELS, type Label } from '../authz/labels.js';
import { FileDocuments } from '../files/documents/service.js';
import { docToMarkdown, markdownToDoc, validateDoc } from '../files/documents/markdown.js';
import { DOC_KINDS, DOC_LIMITS, DocumentError } from '../files/documents/model.js';
import { inferColumns, normalizeSheet, validateNormalizeOptions } from '../files/documents/normalize.js';
import { validateWorkbook } from '../files/documents/sheets.js';
import { fileView, folderView, versionView } from '../files/service.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../http/middleware.js';
import { badRequest, HttpProblem } from '../http/problem.js';
import type { Services } from '../services.js';
import { nameSchema } from './files.js';

const id26 = z.string().length(26);
const categorySchema = z.string().trim().min(1).max(200);

/** A model from a request as the converters' validators read it; their DocumentError is a 400. */
function valid<T>(f: () => T): T {
  try {
    return f();
  } catch (err) {
    if (err instanceof DocumentError) throw new HttpProblem(400, 'Invalid document', err.message);
    throw err;
  }
}

/**
 * 2.0.0, file management: documents edited in the console (Markdown, text, CSV, Excel, OpenDocument text and
 * spreadsheets), copies of files and folders, files added to knowledge bases, and the lookup by content identifier.
 * Mounted before `fileRoutes`. Reading needs `files:read`, changing `files:write`; everything acts inside the caller's
 * workspaces and clearance through the file store, and every change is audited.
 *
 * The JSON body limit of `/api` (256 kB) is too small for a spreadsheet, so the document routes read their own body
 * up to the document limits.
 */
export function fileDocumentRoutes(s: Services): Router {
  const r = Router();
  r.use('/files', noStore, requireAuth());
  const read = requirePermission(s, 'files:read');
  const write = requirePermission(s, 'files:write');
  const docs = new FileDocuments(() => s);

  const audit = (req: Request, action: string, target: Record<string, unknown>, label?: Label, detail?: Record<string, unknown>) => {
    const p = principalOf(req);
    return s.audit.append({ tenantId: p.tenantId, action, kind: 'admin', actor: actorFrom(p, ip(req)), target, ...(label ? { label } : {}), ...(detail ? { detail } : {}), traceId: req.traceId });
  };

  const body = { text: z.string().max(DOC_LIMITS.maxChars).optional(), doc: z.unknown().optional(), workbook: z.unknown().optional(), delimiter: z.enum([',', ';', '\t', '|']).optional() };

  // ---------- documents ----------

  r.get('/files/:id/document', read, async (req, res) => {
    const out = await docs.read(principalOf(req), parseBody(id26, req.params.id));
    await audit(req, 'file.document.opened', { file: out.file.id, version: out.version }, out.label, { kind: out.kind, editable: out.editable });
    res.json(out);
  });

  r.put('/files/:id/document', write, async (req, res) => {
    const b = parseBody(z.object({ kind: z.enum(DOC_KINDS), baseVersion: z.number().int().min(1), ...body }).strict(), req.body);
    const out = await docs.save(principalOf(req), parseBody(id26, req.params.id), b);
    await audit(req, 'file.document.saved', { file: out.file.id, version: out.version.number, workspace: out.file.workspaceId }, out.version.label, { kind: b.kind, base: b.baseVersion, size: out.bytes, sha256: out.version.sha256 });
    res.status(202).json(out);
  });

  r.post('/files/documents', write, async (req, res) => {
    const b = parseBody(z.object({ name: nameSchema, kind: z.enum(DOC_KINDS), label: z.enum(LABELS).default('internal'), folderId: id26.nullable().optional(), workspaceId: id26.optional(), ...body }).strict(), req.body);
    const { file, version } = await docs.create(principalOf(req), b);
    await audit(req, 'file.document.created', { file: file.id, version: version.number, workspace: file.workspace_id }, version.label, { name: file.name, kind: b.kind, folder: file.folder_id, size: version.size, sha256: version.sha256 });
    res.status(202).json({ ...fileView(file), version: versionView(version) });
  });

  r.post('/files/document-convert', read, (req, res) => {
    const b = parseBody(z.object({ kind: z.literal('markdown'), text: z.string().max(DOC_LIMITS.maxChars).optional(), doc: z.unknown().optional() }).strict(), req.body);
    if (b.doc !== undefined) res.json({ text: valid(() => docToMarkdown(validateDoc(b.doc))) });
    else if (b.text !== undefined) res.json({ doc: valid(() => markdownToDoc(b.text!)) });
    else throw badRequest('Give text or doc.');
  });

  r.post('/files/table/normalize', read, (req, res) => {
    const b = parseBody(z.object({ sheet: z.unknown(), options: z.unknown().optional() }).strict(), req.body);
    const sheet = valid(() => validateWorkbook({ sheets: [b.sheet] }).sheets[0]!);
    res.json(valid(() => normalizeSheet(sheet, validateNormalizeOptions(b.options ?? {}))));
  });

  r.post('/files/table/infer', read, (req, res) => {
    const b = parseBody(z.object({ sheet: z.unknown() }).strict(), req.body);
    const sheet = valid(() => validateWorkbook({ sheets: [b.sheet] }).sheets[0]!);
    res.json({ columns: inferColumns({ ...sheet, columns: [] }) });
  });

  // ---------- copies ----------

  r.post('/files/:id/duplicate', write, async (req, res) => {
    const b = parseBody(z.object({ name: nameSchema.optional(), folderId: id26.nullable().optional() }).strict(), req.body ?? {});
    const { file, version, from } = await s.files.duplicate(principalOf(req), parseBody(id26, req.params.id), b);
    await audit(req, 'file.duplicated', { file: file.id, from: from.id, workspace: file.workspace_id }, version.label, { name: file.name, folder: file.folder_id, fromVersion: from.current_version });
    res.status(202).json({ ...fileView(file), version: versionView(version) });
  });

  r.post('/files/folders/:id/duplicate', write, async (req, res) => {
    const b = parseBody(z.object({ name: nameSchema.optional(), parentId: id26.nullable().optional() }).strict(), req.body ?? {});
    const from = parseBody(id26, req.params.id);
    const out = await s.files.duplicateFolder(principalOf(req), from, b);
    await audit(req, 'file.folder.duplicated', { folder: out.folder.id, from, workspace: out.folder.workspace_id }, undefined, { name: out.folder.name, files: out.files, folders: out.folders, skipped: out.skipped });
    res.status(202).json({ ...folderView(out.folder), files: out.files, folders: out.folders, skipped: out.skipped });
  });

  // ---------- knowledge ----------

  r.get('/files/:id/knowledge', read, async (req, res) => {
    res.json(await docs.knowledgeLinks(principalOf(req), parseBody(id26, req.params.id)));
  });

  r.post('/files/:id/knowledge', read, requirePermission(s, 'knowledge:read'), async (req, res) => {
    const b = parseBody(z.object({ kbId: id26, categories: z.array(categorySchema).max(20).optional() }).strict(), req.body);
    const out = await docs.addToKnowledge(principalOf(req), parseBody(id26, req.params.id), b);
    await audit(req, 'knowledge.uploaded', { kb: out.kb.id, document: out.doc.id }, out.doc.label, { name: out.doc.name, size: out.doc.size, file: out.file.id, version: out.version.number, ...(out.link.converted_to ? { convertedTo: out.link.converted_to } : {}), ...(b.categories?.length ? { categories: b.categories } : {}) });
    res.status(201).json({ document: { id: out.doc.id, name: out.doc.name, state: out.doc.state, label: out.doc.label }, kb: { id: out.kb.id, name: out.kb.name }, version: out.version.number, convertedTo: out.link.converted_to });
  });

  // ---------- content identifiers ----------

  r.get('/files/by-cid/:cid', read, async (req, res) => {
    const cid = parseBody(z.string().trim().min(10).max(120), req.params.cid);
    res.json(await s.files.byCid(principalOf(req), cid));
  });

  return r;
}
