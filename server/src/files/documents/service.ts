import { Readable } from 'node:stream';
import { ulid } from 'ulid';
import { clears, labelRank, type Label } from '../../authz/labels.js';
import type { Principal } from '../../authz/policy.js';
import { json } from '../../db/knex.js';
import { conflict, forbidden, HttpProblem } from '../../http/problem.js';
import { ACCEPTED as KNOWLEDGE_TYPES } from '../../knowledge/extract.js';
import type { Services } from '../../services.js';
import { collect } from '../crypt.js';
import { fileView, versionView, type FileRow, type VersionRow } from '../service.js';
import { docToMarkdown, markdownToDoc, validateDoc } from './markdown.js';
import { DOC_LIMITS, DocumentError, EXT, kindOf, MIME, saveKindOf, type Column, type DocKind, type RichDoc, type Sheet, type Workbook } from './model.js';
import { inferColumns } from './normalize.js';
import { docToOdt, odtToDoc } from './odt.js';
import { csvToWorkbook, odsToWorkbook, validateWorkbook, workbookToCsv, workbookToOds, workbookToXlsx, xlsxToWorkbook } from './sheets.js';
import { xlsToWorkbook } from './xls.js';

/*
 * Editable documents (2.0.0): reads a file's current version into the model of its kind (`model.ts`) and writes an
 * edited model back as a new version through `FileService.uploadVersion`, so every save is quarantined and scanned like
 * an upload, keeps the file's label and shows in its versions. A save names the version it was based on; when a newer
 * version exists the save is refused (409) and the person chooses to reload or save a copy.
 *
 * Column definitions of tables and spreadsheets (names, types, required, widths) live in `file_doc_columns`, because a
 * CSV file cannot carry them. Adding a file to a knowledge base sends the current version, converted to Markdown or CSV
 * when the knowledge pipeline does not read its format, and records the link in `file_knowledge_links`.
 */

export interface DocumentBody {
  text?: string;
  doc?: unknown;
  workbook?: unknown;
  delimiter?: string;
}

export const SCAN_WAIT_MS = 15_000;

const decodeText = (buf: Buffer): string => {
  let t: string;
  try {
    t = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    throw new DocumentError('The file is not valid UTF-8 text.');
  }
  t = t.replace(/^\uFEFF/, '');
  if (t.length > DOC_LIMITS.maxChars) throw new HttpProblem(413, 'Too large to edit', `Documents of up to ${DOC_LIMITS.maxChars.toLocaleString('en-US')} characters are edited here.`);
  return t;
};

const checkText = (t: unknown): string => {
  if (typeof t !== 'string') throw new DocumentError('Give the document as text.');
  if (t.length > DOC_LIMITS.maxChars) throw new HttpProblem(413, 'Too large to save', `Documents of up to ${DOC_LIMITS.maxChars.toLocaleString('en-US')} characters are saved here.`);
  return t;
};

const delimiterOf = (d: unknown): ',' | ';' | '\t' | '|' => (d === ';' || d === '\t' || d === '|' ? d : ',');

/** A workbook as Markdown with one table per sheet (what a knowledge base indexes of a spreadsheet with several sheets). */
function workbookMarkdown(title: string, wb: Workbook): string {
  const cell = (s: Sheet, r: number, c: number) => {
    const x = s.rows[r]?.[c];
    const v = x?.v;
    return (v == null ? '' : String(v)).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  };
  const out = [`# ${title}`, ''];
  for (const s of wb.sheets) {
    out.push(`## ${s.name}`, '');
    const width = Math.max(1, ...s.rows.map((r) => r.length));
    if (!s.rows.length) {
      out.push('(empty)', '');
      continue;
    }
    const head = s.header ? s.rows[0]!.map((_, c) => cell(s, 0, c)) : Array.from({ length: width }, (_, c) => s.columns[c]?.name ?? String(c + 1));
    while (head.length < width) head.push('');
    out.push(`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`);
    for (let r = s.header ? 1 : 0; r < s.rows.length; r++) out.push(`| ${Array.from({ length: width }, (_, c) => cell(s, r, c)).join(' | ')} |`);
    out.push('');
  }
  return out.join('\n');
}

export class FileDocuments {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  private get files() {
    return this.s().files;
  }

  /** The bytes of a version as the content stream gives them, refused past the document limit. */
  private async bytes(version: VersionRow, stream: AsyncIterable<Buffer>): Promise<Buffer> {
    if (version.size > DOC_LIMITS.maxBytes) throw new HttpProblem(413, 'Too large to edit', `Files of up to ${DOC_LIMITS.maxBytes.toLocaleString('en-US')} bytes are opened here; download this one instead.`);
    return collect(stream, DOC_LIMITS.maxBytes);
  }

  /** The bytes of a file in a model: Markdown and text as UTF-8, the rest through their writers. */
  encode(kind: DocKind, body: DocumentBody, name: string): { data: Buffer; columns: Record<string, Column[]> | null } {
    try {
      if (kind === 'text') return { data: Buffer.from(checkText(body.text ?? ''), 'utf8'), columns: null };
      if (kind === 'markdown') return { data: Buffer.from(body.doc !== undefined ? docToMarkdown(validateDoc(body.doc)) : checkText(body.text ?? ''), 'utf8'), columns: null };
      if (kind === 'xls') throw new DocumentError('Excel 97-2003 (.xls) files are read here but not written; save the workbook as an .xlsx copy.');
      if (kind === 'odt') return { data: docToOdt(validateDoc(body.doc ?? { blocks: [] }), { title: name.replace(/\.[^.]+$/, '') }), columns: null };
      const wb = validateWorkbook(body.workbook ?? { sheets: [{ name: 'Sheet1', header: kind === 'csv', columns: [], rows: [] }] });
      const columns = Object.fromEntries(wb.sheets.map((s) => [s.name, s.columns]));
      if (kind === 'csv') {
        if (wb.sheets.length !== 1) throw new DocumentError('A CSV file has one sheet.');
        return { data: Buffer.from(workbookToCsv(wb.sheets[0]!, delimiterOf(body.delimiter)), 'utf8'), columns };
      }
      return { data: kind === 'xlsx' ? workbookToXlsx(wb) : workbookToOds(wb), columns };
    } catch (err) {
      if (err instanceof DocumentError) throw new HttpProblem(400, 'Invalid document', err.message);
      throw err;
    }
  }

  /** A stored file's bytes as the model of its kind, with what the conversion could not keep. */
  decode(kind: DocKind, data: Buffer): { text?: string; doc?: RichDoc; workbook?: Workbook; delimiter?: string; notes: string[] } {
    try {
      if (kind === 'text') return { text: decodeText(data), notes: [] };
      if (kind === 'markdown') {
        const text = decodeText(data);
        return { text, doc: markdownToDoc(text), notes: [] };
      }
      if (kind === 'odt') return odtToDoc(data);
      if (kind === 'csv') {
        const { workbook, delimiter } = csvToWorkbook(decodeText(data));
        return { workbook, delimiter, notes: [] };
      }
      if (kind === 'xls') return xlsToWorkbook(data);
      return kind === 'xlsx' ? xlsxToWorkbook(data) : odsToWorkbook(data);
    } catch (err) {
      if (err instanceof DocumentError) throw new HttpProblem(422, 'Document not readable', err.message);
      throw err;
    }
  }

  private async savedColumns(fileId: string): Promise<Record<string, Column[]> | null> {
    const r = (await this.db('file_doc_columns').where({ file_id: fileId }).first('sheets')) as { sheets: unknown } | undefined;
    return r ? json<Record<string, Column[]> | null>(r.sheets, null) : null;
  }

  private async saveColumns(file: FileRow, columns: Record<string, Column[]>, by: string): Promise<void> {
    const row = { sheets: JSON.stringify(columns), updated_by: by, updated_at: Date.now() };
    const n = await this.db('file_doc_columns').where({ file_id: file.id }).update(row);
    if (!n) await this.db('file_doc_columns').insert({ file_id: file.id, tenant_id: file.tenant_id, ...row });
  }

  /** Saved column definitions laid over a sheet: the stored type, required and width win; names follow the header. */
  private overlay(wb: Workbook, saved: Record<string, Column[]> | null): Workbook {
    if (!saved) return wb;
    return {
      sheets: wb.sheets.map((s) => {
        const keep = saved[s.name];
        if (!keep?.length) return s;
        const inferred = s.columns.length ? s.columns : inferColumns(s);
        const columns = inferred.map((c, i) => (keep[i] ? { ...c, type: keep[i]!.type, ...(keep[i]!.required ? { required: true } : {}), ...(keep[i]!.width ? { width: keep[i]!.width } : {}), ...(s.header ? {} : { name: keep[i]!.name || c.name }) } : c));
        for (let i = inferred.length; i < keep.length; i++) columns.push(keep[i]!);
        return { ...s, columns };
      })
    };
  }

  /** A file opened for the editor: readers of shared files get it read-only. */
  async read(p: Principal, id: string) {
    const { file, version, stream } = await this.files.content(p, id);
    const kind = kindOf(version.type, file.name);
    if (!kind) {
      await (stream as AsyncGenerator<Buffer>).return?.(undefined);
      throw new HttpProblem(415, 'Not editable here', `${file.name} is ${version.type ?? 'of an unknown type'}. Markdown, text, CSV, Excel (.xlsx, and .xls read as a copy) and OpenDocument text and spreadsheets (.odt, .ods) are edited here; download other files.`);
    }
    const data = await this.bytes(version, stream);
    const editable = await this.files.writable(p, id).then(() => true, () => false);
    const out = this.decode(kind, data);
    if (out.workbook) out.workbook = this.overlay(out.workbook, await this.savedColumns(file.id));
    return { file: fileView(file), kind, version: version.number, label: version.label, editable, saveKind: saveKindOf(kind), ...out };
  }

  /** Writes an edited model as a new version of the file, unless a newer version than `baseVersion` exists. */
  async save(p: Principal, id: string, input: DocumentBody & { kind: DocKind; baseVersion: number }) {
    const file = await this.files.writable(p, id);
    const kind = kindOf(file.type, file.name);
    if (!kind) throw new HttpProblem(415, 'Not editable here', `${file.name} is not a document edited here.`);
    if (kind !== input.kind && !(kind === 'text' && input.kind === 'markdown')) throw conflict(`${file.name} is ${kind}, not ${input.kind}.`);
    const latest = await this.files.lastVersionNumber(file.id);
    if (latest !== input.baseVersion) {
      throw new HttpProblem(409, 'Conflict', `Version ${latest} of ${file.name} was saved after version ${input.baseVersion}, which you edited. Reload it, or save your changes as a copy.`, { extensions: { latest, current: file.current_version, step: 'version' } });
    }
    const { data, columns } = this.encode(kind, input, file.name);
    const { version } = await this.files.uploadVersion(p, file.id, { declaredType: MIME[kind], declaredBytes: data.length }, Readable.from([data]));
    if (columns) await this.saveColumns(file, columns, p.userId);
    const scanned = (await this.files.scanNow(version.id, SCAN_WAIT_MS)) ?? version;
    return { file: fileView(await this.files.writable(p, file.id)), version: versionView(scanned), bytes: data.length };
  }

  /** A new document file from a model (or the kind's starting content), in a folder of the caller's workspace. */
  async create(p: Principal, input: DocumentBody & { name: string; kind: DocKind; label: Label; folderId?: string | null; workspaceId?: string | null }) {
    const ext = EXT[input.kind];
    const name = input.name.toLowerCase().endsWith(ext) || (input.kind === 'markdown' && /\.markdown$/i.test(input.name)) || (input.kind === 'csv' && /\.tsv$/i.test(input.name)) ? input.name : `${input.name}${ext}`;
    if (name.length > 255) throw new HttpProblem(400, 'Invalid request', 'The name is too long with its extension.');
    const title = name.replace(/\.[^.]+$/, '');
    const body: DocumentBody = { ...input };
    if (input.kind === 'markdown' && body.doc === undefined && !body.text) body.text = `# ${title}\n\n`;
    if (input.kind === 'odt' && body.doc === undefined) body.doc = { blocks: [{ type: 'heading', level: 1, runs: [{ text: title }] }, { type: 'paragraph', runs: [] }] };
    if (input.kind === 'csv' && body.workbook === undefined) body.workbook = { sheets: [{ name: 'Sheet1', header: true, columns: [{ name: 'Name', type: 'text' }, { name: 'Value', type: 'text' }], rows: [[{ v: 'Name' }, { v: 'Value' }]] }] };
    const { data, columns } = this.encode(input.kind, body, name);
    const { file, version } = await this.files.upload(p, { workspaceId: input.workspaceId ?? null, folderId: input.folderId ?? null, name, label: input.label, declaredType: MIME[input.kind], declaredBytes: data.length }, Readable.from([data]));
    if (columns) await this.saveColumns(file, columns, p.userId);
    const scanned = (await this.files.scanNow(version.id, SCAN_WAIT_MS)) ?? version;
    return { file: await this.files.writable(p, file.id), version: scanned };
  }

  // ---------- knowledge (2.0.0) ----------

  /**
   * Adds a file's current version to a knowledge base the caller curates: as it is when the knowledge pipeline reads
   * its type, otherwise converted (OpenDocument text to Markdown, a spreadsheet to CSV, or to Markdown tables when it
   * has several sheets). The document keeps at least the version's label and may not sit in a base below it.
   */
  async addToKnowledge(p: Principal, id: string, input: { kbId: string; categories?: string[] }) {
    const s = this.s();
    const kb = await s.knowledge.base(p, input.kbId, 'manage');
    const { file, version, stream } = await this.files.content(p, id);
    if (labelRank(version.label) > labelRank(kb.label)) {
      await (stream as AsyncGenerator<Buffer>).return?.(undefined);
      throw forbidden(`${file.name} is ${version.label}; ${kb.name} holds documents up to ${kb.label}.`, { step: 'label' });
    }
    const kind = kindOf(version.type, file.name);
    let data: Buffer;
    let name = file.name;
    let converted: string | null = null;
    if (version.type && KNOWLEDGE_TYPES.includes(version.type)) {
      if (version.size > s.cfg.ATTACHMENT_MAX_BYTES) throw new HttpProblem(413, 'Too large', `A knowledge base takes files up to ${s.cfg.ATTACHMENT_MAX_BYTES.toLocaleString('en-US')} bytes.`);
      data = await collect(stream, s.cfg.ATTACHMENT_MAX_BYTES);
    } else if (kind === 'odt' || kind === 'xlsx' || kind === 'ods' || kind === 'xls') {
      const model = this.decode(kind, await this.bytes(version, stream));
      const stem = file.name.replace(/\.[^.]+$/, '');
      if (model.doc) {
        data = Buffer.from(docToMarkdown(model.doc), 'utf8');
        name = `${stem}.md`;
        converted = 'text/markdown';
      } else if (model.workbook && model.workbook.sheets.length === 1) {
        data = Buffer.from(workbookToCsv(model.workbook.sheets[0]!, ','), 'utf8');
        name = `${stem}.csv`;
        converted = 'text/csv';
      } else {
        data = Buffer.from(workbookMarkdown(stem, model.workbook ?? { sheets: [] }), 'utf8');
        name = `${stem}.md`;
        converted = 'text/markdown';
      }
    } else {
      await (stream as AsyncGenerator<Buffer>).return?.(undefined);
      throw new HttpProblem(415, 'Not a knowledge type', `${file.name} is ${version.type ?? 'of an unknown type'}. Knowledge bases take text, Markdown, CSV, JSON, HTML, PDF, Word, images, and OpenDocument and Excel files converted to text.`);
    }
    const doc = await s.knowledge.upload(p, kb.id, { name, label: version.label, data, categories: input.categories ?? [] });
    const link = { id: ulid(), tenant_id: p.tenantId, file_id: file.id, version: version.number, kb_id: kb.id, document_id: doc.id, converted_to: converted, created_by: p.userId, created_at: Date.now() };
    await this.db('file_knowledge_links').insert(link);
    return { file, version, kb, doc, link };
  }

  /** The knowledge bases a file was added to, with each document's state now (for readers of the file). */
  async knowledgeLinks(p: Principal, id: string) {
    const { file } = await this.files.readable(p, id);
    const rows = (await this.db('file_knowledge_links as l')
      .leftJoin('knowledge_bases as b', 'b.id', 'l.kb_id')
      .leftJoin('knowledge_documents as d', 'd.id', 'l.document_id')
      .where({ 'l.tenant_id': p.tenantId, 'l.file_id': file.id })
      .orderBy('l.created_at', 'desc')
      .select('l.*', 'b.name as kb_name', 'b.label as kb_label', 'd.state as doc_state', 'd.label as doc_label')) as Record<string, unknown>[];
    return rows
      .filter((r) => !r.kb_label || clears(p.clearance, r.kb_label as Label))
      .map((r) => ({ id: r.id, kbId: r.kb_id, kbName: (r.kb_name as string | null) ?? null, documentId: r.document_id, documentState: (r.doc_state as string | null) ?? 'removed', version: Number(r.version), current: Number(r.version) === file.current_version, convertedTo: r.converted_to ?? null, createdAt: Number(r.created_at) }));
  }
}
